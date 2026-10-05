import { afterEach, expect, test } from "bun:test";
import { PhoneGateway } from "../src/remote/gateway";
import { tailscaleIdentity, type ReaderBackend } from "../src/remote/contracts";
import type { PasskeyProvider } from "../src/remote/passkeys";

const READER = "https://reader.example", AUTH = "https://approval.example", OWNER = "owner@example.test";
const gateways: PhoneGateway[] = [];
afterEach(() => { for (const gateway of gateways.splice(0)) gateway.close(); });

function fixture(backendOverride?: ReaderBackend) {
  let time = 1000, enrolled = true, challengeIndex = 0, calls = 0, closed = 0;
  const resources: string[] = [], opened: string[] = [], bodies: any[] = [];
  const passkeys: PasskeyProvider = {
    enrolled: () => enrolled,
    registrationOptions: async () => ({ challenge: `registration-${++challengeIndex}` } as any),
    register: async (challenge, response) => { if ((response as any)?.proof !== challenge) throw new Error(); enrolled = true; },
    authenticationOptions: async () => ({ challenge: `authentication-${++challengeIndex}` } as any),
    authenticate: async (challenge, response) => { calls++; if ((response as any)?.proof !== challenge) throw new Error(); },
  };
  const backend: ReaderBackend = backendOverride ?? {
    open: async id => { opened.push(id); return {
      close: async () => { closed++; },
      request: async (resource, request) => {
        resources.push(resource); if (request.body) bodies.push(await request.json());
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.headers.get("authorization")).toBeNull();
        if (resource === "api/bootstrap") return Response.json({ document: { body: "Hello", annotations: {} }, draft: { body: "old" }, capabilities: { revealFile: true } });
        if (resource === "api/file") return Response.json({ body: "Hello", annotations: {} });
        return new Response("ok", { headers: { "set-cookie": "upstream=secret", location: "http://127.0.0.1/launch?ticket=secret" } });
      },
    }; },
  };
  const gateway = new PhoneGateway({ readerOrigin: READER, approvalOrigin: AUTH, owner: OWNER, document: { id: "doc-id", title: "Example" },
    identify: tailscaleIdentity(OWNER), passkeys, backend, authJavaScript: "", now: () => time, sessionMs: 10000 });
  gateways.push(gateway);
  const send = (surface: "reader" | "approval", path: string, method = "GET", body?: unknown, cookie = "", extra: Record<string, string> = {}) => {
    const base = surface === "reader" ? READER : AUTH;
    return gateway.handle(new Request(base + path, { method, headers: { host: new URL(base).host,
      "tailscale-user-login": OWNER, ...(method !== "GET" ? { origin: base } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie, ...extra },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }), surface);
  };
  const begin = async () => {
    const start = await send("reader", "/start", "POST");
    return { id: new URL(start.headers.get("location")!).searchParams.get("request")!, binding: start.headers.get("set-cookie")!.split(";")[0]! };
  };
  const approve = async (id: string) => {
    const options = await (await send("approval", "/authentication/options", "POST", { requestId: id })).json();
    const proof = { challengeId: options.id, response: { proof: options.options.challenge } };
    const result = await send("approval", "/authentication/verify", "POST", proof);
    return { result, proof };
  };
  const accept = (code: string, binding: string) => send("reader", "/accept", "POST", new URLSearchParams({ code }).toString(), binding,
    { origin: READER, "content-type": "application/x-www-form-urlencoded" });
  const login = async () => {
    const { id, binding } = await begin(); const { result } = await approve(id); const { code } = await result.json();
    const response = await accept(code, binding); expect(response.status).toBe(303);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { gateway, send, begin, approve, accept, login, resources, opened, bodies, setTime: (v: number) => { time = v; },
    unenroll: () => { enrolled = false; }, calls: () => calls, closed: () => closed };
}

test("identity, Host and Origin are checked before opening any document", async () => {
  const f = fixture();
  for (const headers of [{ host: "evil.example" }, { "tailscale-user-login": "" }, { "tailscale-user-login": "other" }, { origin: AUTH }] as Record<string, string>[]) {
    expect((await f.send("reader", "/start", "POST", undefined, "", headers)).status).toBe(403);
  }
  expect((await f.send("reader", "/reader/api/file")).status).toBe(401);
  expect(f.opened).toEqual([]);
});

test("passkey, browser binding, one-use handoff, and document ID bound backend", async () => {
  const f = fixture(); const { id, binding } = await f.begin();
  const { result, proof } = await f.approve(id); expect(result.status).toBe(200);
  expect((await f.send("approval", "/authentication/verify", "POST", proof)).status).toBe(403);
  const { code } = await result.json();
  expect((await f.accept(code, "")).status).toBe(403);
  expect((await f.accept(code, binding)).status).toBe(403);
  const session = await f.login(); expect(f.opened).toEqual(["doc-id"]);
  const read = await f.send("reader", "/reader/api/bootstrap", "GET", undefined, session);
  const value = await read.json(); expect(value.document.bodyEditable).toBe(false); expect(value.draft).toBeNull(); expect(value.capabilities).toEqual({});
  expect(read.headers.get("set-cookie")).toBeNull();
  const asset = await f.send("reader", "/reader/app-123.js", "GET", undefined, session);
  expect(asset.headers.get("set-cookie")).toBeNull(); expect(asset.headers.get("location")).toBeNull();
});

test("only permitted operations pass; comment event cannot smuggle another operation", async () => {
  const f = fixture(), session = await f.login();
  for (const [path, method, body] of [["/control/status", "GET", undefined], ["/reader/api/file", "PUT", {}],
    ["/reader/api/open", "POST", { target: "/private.md" }], ["/reader/api/updates", "GET", undefined],
    ["/reader/api/annotations", "POST", { type: "delete" }], ["/reader/api/annotations/resolve", "POST", {}],
    ["/reader/api/file/move", "POST", {}]] as const) {
    expect((await f.send("reader", path, method, body, session)).status).toBeGreaterThanOrEqual(400);
  }
  expect(f.resources).toEqual([]);
  expect((await f.send("reader", "/reader/api/annotations", "POST", { type: "comment", actor: "system", body: "Note" }, session)).status).toBe(200);
  expect(f.bodies[0].actor).toBe("human");
});

test("hard expiry cannot be extended by activity and revoke closes upstream", async () => {
  const f = fixture(), session = await f.login();
  f.setTime(10000); expect((await f.send("reader", "/reader/api/file", "GET", undefined, session)).status).toBe(200);
  f.setTime(11000); expect((await f.send("reader", "/reader/api/file", "GET", undefined, session)).status).toBe(401);
  expect(f.closed()).toBe(1);
  const second = await f.login(); const pending = await f.begin();
  const { result } = await f.approve("revoke"); expect(await result.json()).toEqual({ revoked: true });
  expect((await f.send("reader", "/reader/api/file", "GET", undefined, second)).status).toBe(401);
  expect((await f.send("approval", "/authentication/options", "POST", { requestId: pending.id })).status).toBe(403);
});

test("enrollment is closed until an explicit local ceremony and code cannot be reused", async () => {
  const f = fixture(); f.unenroll();
  expect((await f.send("approval", "/registration/options", "POST", { code: "guessed" })).status).toBe(403);
  const code = f.gateway.beginEnrollment();
  const response = await f.send("approval", "/registration/options", "POST", { code }); expect(response.status).toBe(200);
  expect((await f.send("approval", "/registration/options", "POST", { code })).status).toBe(403);
  const { id, options } = await response.json();
  expect((await f.send("approval", "/registration/verify", "POST", { challengeId: id, response: { proof: options.challenge } })).status).toBe(200);
  expect(() => f.gateway.beginEnrollment()).toThrow();
});

test("expired and failed challenges cannot be replayed", async () => {
  const f = fixture(); const { id } = await f.begin();
  const options = await (await f.send("approval", "/authentication/options", "POST", { requestId: id })).json();
  const body = { challengeId: options.id, response: { proof: "invalid" } };
  expect((await f.send("approval", "/authentication/verify", "POST", body)).status).toBe(403);
  body.response.proof = options.options.challenge;
  expect((await f.send("approval", "/authentication/verify", "POST", body)).status).toBe(403);
  const next = await (await f.send("approval", "/authentication/options", "POST", { requestId: id })).json();
  f.setTime(122000);
  expect((await f.send("approval", "/authentication/verify", "POST", { challengeId: next.id, response: { proof: next.options.challenge } })).status).toBe(403);
});

test("revocation during asynchronous backend open cannot produce a session", async () => {
  let release!: () => void, closed = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ open: async () => { await barrier; return { request: async () => new Response(), close: async () => { closed = true; } }; } });
  const { id, binding } = await f.begin(); const { result } = await f.approve(id); const { code } = await result.json();
  const pending = f.accept(code, binding); await Bun.sleep(0); f.gateway.revokeAll(); release();
  expect((await pending).status).toBe(403); expect(closed).toBe(true);
});

test("only hashed application assets are cached, with negotiated gzip and no authority headers", async () => {
  const f = fixture(), session = await f.login();
  const asset = await f.send("reader", "/reader/chunk-12345678.css", "GET", undefined, session, { "accept-encoding": "gzip" });
  expect(asset.headers.get("content-encoding")).toBe("gzip");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await asset.arrayBuffer())))).toBe("ok");
  expect(asset.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
  expect(asset.headers.get("vary")).toBe("Accept-Encoding");
  expect(asset.headers.get("set-cookie")).toBeNull();
  const plain = await f.send("reader", "/reader/chunk-12345678.css", "GET", undefined, session, { "accept-encoding": "gzip;q=0" });
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toBe("ok");
  for (const resource of ["", "api/file", "api/bootstrap", "app.js"]) {
    expect((await f.send("reader", `/reader/${resource}`, "GET", undefined, session)).headers.get("cache-control")).toBe("no-store");
  }
  f.gateway.revokeAll();
  const denied = await f.send("reader", "/reader/chunk-12345678.css", "GET", undefined, session);
  expect(denied.status).toBe(401);
  expect(denied.headers.get("cache-control")).toBe("no-store");
});

test("root and expired reader pages restart bound passkey login; APIs stay unauthorized", async () => {
  const f = fixture();
  const session = await f.login();
  expect((await f.send("reader", "/", "GET", undefined, session)).headers.get("location")).toBe("/reader/");
  f.gateway.revokeAll();
  for (const path of ["/", "/reader/"]) {
    const response = await f.send("reader", path, "GET", undefined, session);
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe(AUTH);
    const binding = response.headers.get("set-cookie")!.split(";")[0]!;
    const { result } = await f.approve(target.searchParams.get("request")!);
    const { code } = await result.json();
    expect((await f.accept(code, binding)).status).toBe(303);
  }
  expect((await f.send("reader", "/reader/api/file", "GET", undefined, session)).status).toBe(401);
  expect((await f.send("reader", "/reader/app.js", "GET", undefined, session)).status).toBe(401);
});

test("stale approval tabs return to the reader to obtain a new binding", async () => {
  const f = fixture(); const { id } = await f.begin();
  f.gateway.revokeAll();
  const response = await f.send("approval", `/?request=${id}`);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${READER}/`);
  expect(f.opened).toEqual([]);
});

test("navigation explains missing transport identity without bypassing it or creating a login", async () => {
  const f = fixture();
  for (const surface of ["reader", "approval"] as const) {
    const response = await f.send(surface, "/", "GET", undefined, "", { "tailscale-user-login": "", accept: "text/html" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Private connection required");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  expect(f.opened).toEqual([]);
});


test("Folio lists only the adapter catalog and scopes tabs to distinct documents", async () => {
  const calls: string[] = [], closed: string[] = [];
  let visible = true;
  const f = fixture({
    list: async () => visible ? [{ id: "second", title: "Second" }] : [],
    open: async id => ({ close: async () => { closed.push(id); }, request: async resource => {
      calls.push(id + ":" + resource);
      return Response.json({ body: id, annotations: {} });
    } }),
  });
  expect((await f.send("reader", "/reader/api/folio")).status).toBe(401);
  const cookie = await f.login();
  expect(await (await f.send("reader", "/reader/api/folio", "GET", undefined, cookie)).json()).toEqual([{ id: "second", title: "Second" }]);
  expect((await f.send("reader", "/reader/d/unknown/api/file", "GET", undefined, cookie)).status).toBe(404);
  const second = await (await f.send("reader", "/reader/d/second/api/file", "GET", undefined, cookie)).json();
  expect(second.body).toBe("second"); expect(second.path).toBe("Second");
  const first = await (await f.send("reader", "/reader/api/file", "GET", undefined, cookie)).json();
  expect(first.body).toBe("doc-id");
  expect((await f.send("reader", "/reader/d/second/api/file", "PUT", {}, cookie)).status).toBe(403);
  visible = false;
  expect((await f.send("reader", "/reader/d/second/api/file", "GET", undefined, cookie)).status).toBe(404);
  expect(calls).toEqual(["second:api/file", "doc-id:api/file"]);
  f.gateway.revokeAll(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(closed.sort()).toEqual(["doc-id", "second"]);
});

test('shared font assets and conditional reads enforce session and current membership', async () => {
  let member = true, probes = 0, lists = 0;
  const f = fixture({
    list: async () => { lists++; return []; },
    member: async id => { probes++; return member ? { id, title: 'Member' } : null; },
    open: async () => ({ close: async () => {}, request: async (resource, request) => {
      if (resource === 'api/file') {
        expect(request.headers.get('if-none-match')).toBe('"revision"');
        return new Response(null, { status: 304, headers: { etag: '"revision"' } });
      }
      return new Response('font', { headers: { 'content-type': 'font/ttf' } });
    } }),
  });
  const session = await f.login();
  expect((await f.send('reader', '/assets/font-12345678.ttf', 'GET', undefined, session)).status).toBe(200);
  expect((await f.send('reader', '/assets/font-12345678.ttf')).status).toBe(401);
  expect((await f.send('reader', '/reader/d/member/api/file', 'GET', undefined, session, { 'if-none-match': '"revision"' })).status).toBe(304);
  member = false;
  expect((await f.send('reader', '/reader/d/member/api/file', 'GET', undefined, session, { 'if-none-match': '"revision"' })).status).toBe(404);
  expect(probes).toBe(3); expect(lists).toBe(0);
  expect((await f.send('reader', '/reader/d/member/api/updates', 'GET', undefined, session)).status).toBe(403);
  expect(probes).toBe(3);
});

test("phone can select themes but cannot edit the theme library or other preferences", async () => {
  const f = fixture(), session = await f.login();
  for (const theme of ["tether", "custom-test"]) {
    expect((await f.send("reader", "/reader/api/preferences", "PUT", { theme }, session)).status).toBe(200);
    expect(f.bodies.at(-1)).toEqual({ theme });
  }
  for (const body of [{ saveTheme: {} }, { deleteTheme: "custom-test" }, { theme: "tether", saveTheme: {} }, { uiScale: 2 }, { inheritPaseoTheme: true }]) {
    expect((await f.send("reader", "/reader/api/preferences", "PUT", body, session)).status).toBe(403);
  }
  expect((await f.send("reader", "/reader/api/preferences", "PUT", { theme: "tether" }, session, { origin: AUTH })).status).toBe(403);
  expect(f.resources).toEqual(["api/preferences", "api/preferences"]);
});
