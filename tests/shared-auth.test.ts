import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SharedAuth, type SharedCredential } from "../src/remote/shared-auth";
import { SharedGateway } from "../src/remote/shared-gateway";
import type { PasskeyProvider } from "../src/remote/passkeys";
import type { ReaderBackend } from "../src/remote/contracts";

const ORIGIN = "https://library.example.test";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(input: { localMachineId?: string; reader?: ReaderBackend; dispatch?: (operation: string, body: Record<string, unknown>) => Promise<unknown> } = {}) {
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  let time = Date.now(), enrolled = true, generation = 0, index = 0;
  const passkeys: PasskeyProvider = {
    enrolled: () => enrolled,
    registrationOptions: async () => ({ challenge: `register-${++index}` } as any),
    recoveryOptions: async () => ({ challenge: `replace-${++index}` } as any),
    register: async (challenge, response) => { if ((response as any)?.proof !== challenge) throw new Error("bad proof"); enrolled = true; },
    replace: async (challenge, response) => { if ((response as any)?.proof !== challenge) throw new Error("bad proof"); generation++; enrolled = true; },
    authenticationOptions: async () => ({ challenge: `owner-${generation}-${++index}` } as any),
    authenticate: async (challenge, response) => { if ((response as any)?.proof !== challenge || !challenge.startsWith(`owner-${generation}-`)) throw new Error("bad proof"); },
  };
  const auth = new SharedAuth({ db, passkeys, origin: ORIGIN, localMachineId: input.localMachineId, now: () => time });
  const gateway = new SharedGateway({ auth, dispatch: input.dispatch ?? (async (operation, body) => ({ operation, body })), reader: input.reader });
  cleanups.push(() => gateway.close());
  async function send(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") {
    return gateway.handle(new Request(`${ORIGIN}${path}`, { method, headers: { host: new URL(ORIGIN).host, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  async function options(body: Record<string, unknown>) {
    const response = await send("/auth/options", body, { origin: ORIGIN });
    expect(response.status).toBe(200);
    return { value: await response.json(), cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }
  const finish = (option: Awaited<ReturnType<typeof options>>, headers: Record<string, string> = {}) => send("/auth/verify", { challengeId: option.value.id, response: { proof: option.value.options.challenge } }, { origin: ORIGIN, cookie: option.cookie, ...headers });
  async function pair(kind = "agent") {
    return (await send("/auth/pair", { name: kind === "agent" ? "Ubuntu agent" : "Ubuntu files", kind })).json();
  }
  async function approve(pair: any) { return finish(await options({ action: "approve", requestId: pair.requestId, code: pair.code })); }
  async function enroll(kind = "agent"): Promise<SharedCredential> {
    const pending = await pair(kind); expect((await approve(pending)).status).toBe(200);
    const response = await send("/auth/pair/poll", { requestId: pending.requestId, pollSecret: pending.pollSecret });
    expect(response.status).toBe(200); return (await response.json()).credential;
  }
  async function login() {
    const result = await finish(await options({ action: "login", name: "Mac browser" }));
    expect(result.status).toBe(200); return result.headers.get("set-cookie")!;
  }
  return { auth, gateway, db, passkeys, send, options, finish, pair, approve, enroll, login, advance: (ms: number) => { time += ms; }, unenroll: () => { enrolled = false; }, generation: () => generation };
}

test("public transport rejects wrong host/origin and ignores asserted proxy identity", async () => {
  const f = fixture();
  expect((await f.send("/folio/")).headers.get("location")).toBe("/auth/login");
  for (const headers of [{ host: "attacker.test" }, { origin: "https://attacker.test" }] as Record<string, string>[]) expect((await f.send("/auth/pair", { name: "Agent", kind: "agent" }, headers)).status).toBe(403);
  expect((await f.send("/api/shared/document.read", {}, { "tailscale-user-login": "owner", "x-forwarded-user": "owner" })).status).toBe(401);
  expect((await f.send("/control/status")).status).toBe(401);
});

test("owner pairing issues one credential; bearer values are absent from the central store", async () => {
  const f = fixture(), pair = await f.pair();
  expect(pair.verificationUrl).not.toContain(pair.pollSecret);
  expect(pair.verificationUrl).not.toContain(pair.code);
  expect((await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).status).toBe("pending");
  expect((await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: "wrong" })).status).toBe(403);
  expect((await f.approve(pair)).status).toBe(200);
  const response = await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret });
  const credential = (await response.json()).credential;
  expect((await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).credential).toEqual(credential);
  expect(JSON.stringify(f.db.query("SELECT * FROM shared_clients").all())).not.toContain(credential.token);
  expect(f.auth.client(credential.clientId)?.name).toBe("Ubuntu agent");
  const read = await f.send("/api/shared/document.read", { documentId: "doc", actor: "assistant" }, { authorization: `Bearer ${credential.token}` });
  expect(await read.json()).toMatchObject({ body: { actor: "assistant" } });
  expect((await f.send("/auth/options", { action: "list" }, { authorization: `Bearer ${credential.token}` })).status).toBe(403);
});

test("connector enrollment assigns a machine identity and owner-approved reenrollment preserves it", async () => {
  const f = fixture();
  const response = await f.send("/auth/pair", { name: "Ubuntu", kind: "connector" });
  const pair = await response.json(); await f.approve(pair);
  const credential = (await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).credential;
  expect(credential.machineId).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.auth.client(credential.clientId)).toMatchObject({ kind: "connector", machineId: credential.machineId });
  const pending = await (await f.send("/auth/pair", { name: "Ubuntu replacement", kind: "connector", machineId: credential.machineId })).json();
  const context = await (await f.send("/auth/pair/context", { requestId: pending.requestId }, { origin: ORIGIN })).json();
  expect(context).toMatchObject({ machineId: credential.machineId, replaces: ["Ubuntu"] });
  expect(f.auth.client(credential.clientId)).not.toBeNull();
  await f.approve(pending);
  const next = (await (await f.send("/auth/pair/poll", { requestId: pending.requestId, pollSecret: pending.pollSecret })).json()).credential;
  expect(next.machineId).toBe(credential.machineId); expect(next.clientId).not.toBe(credential.clientId);
  expect(f.auth.client(credential.clientId)).toBeNull(); expect(f.auth.clients()).toHaveLength(2);
});

test("the hub can enroll its own agent client but cannot pair a connector to itself", async () => {
  const machineId = crypto.randomUUID(), f = fixture({ localMachineId: machineId });
  f.auth.machines.set(machineId, "Hub");
  expect((await f.send("/auth/pair", { name: "Hub files", kind: "connector", machineId })).status).toBe(400);
  const pending = await f.send("/auth/pair", { name: "Hub Paseo", kind: "agent", machineId });
  expect(pending.status).toBe(200);
  const pair = await pending.json();
  expect((await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).status).toBe("pending");
  await f.approve(pair);
  const credential = (await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).credential;
  expect(f.auth.client(credential.clientId)).toMatchObject({ kind: "agent", machineId });
});

test("pairing attempts and request lifetime are bounded", async () => {
  const f = fixture(), pair = await f.pair();
  for (let attempt = 0; attempt < 5; attempt++) expect((await f.send("/auth/options", { action: "approve", requestId: pair.requestId, code: "WRONG" }, { origin: ORIGIN })).status).toBe(403);
  expect((await f.send("/auth/options", { action: "approve", requestId: pair.requestId, code: pair.code }, { origin: ORIGIN })).status).toBe(403);
  const second = await f.pair(); f.advance(300_001);
  expect((await f.send("/auth/pair/poll", { requestId: second.requestId, pollSecret: second.pollSecret })).status).toBe(403);
});

test("proofs bind to one browser ceremony, expire, and cannot be replayed", async () => {
  const f = fixture(), first = await f.options({ action: "login" });
  expect((await f.finish(first, { cookie: "" })).status).toBe(403);
  expect((await f.finish(first)).status).toBe(403);
  const expired = await f.options({ action: "login" }); f.advance(120_001);
  expect((await f.finish(expired)).status).toBe(403);
  const valid = await f.options({ action: "login" });
  expect((await f.finish(valid)).status).toBe(200);
  expect((await f.finish(valid)).status).toBe(403);
});

test("browser cookies and agent tokens have distinct channels and fixed expiration", async () => {
  const f = fixture(), browser = await f.login(), cookie = browser.split(";")[0]!;
  expect(browser).toContain("Secure; HttpOnly; SameSite=Strict; Max-Age=2592000");
  expect((await f.send("/api/shared/document.read", {}, { cookie })).status).toBe(403);
  expect((await f.send("/api/shared/document.read", {}, { cookie, origin: ORIGIN })).status).toBe(200);
  const raw = cookie.slice(cookie.indexOf("=") + 1);
  expect((await f.send("/api/shared/document.read", {}, { authorization: `Bearer ${raw}` })).status).toBe(401);
  const agent = await f.enroll();
  expect((await f.send("/api/shared/document.read", {}, { cookie: `__Host-tether-shared=${agent.token}`, origin: ORIGIN })).status).toBe(401);
  f.advance(30 * 86_400_000);
  expect((await f.send("/api/shared/document.read", {}, { cookie, origin: ORIGIN })).status).toBe(401);
  expect(f.auth.client(agent.clientId)).not.toBeNull();
  f.advance(60 * 86_400_000);
  expect(f.auth.client(agent.clientId)).toBeNull();
});

test("owner replacement preserves enrolled clients and cancels old pending approvals", async () => {
  const f = fixture(), credential = await f.enroll(), pending = await f.pair();
  const oldProof = await f.options({ action: "list" });
  const { code } = f.auth.beginEnrollment({ replace: true });
  const setup = await f.options({ action: "register", code });
  expect((await f.send("/auth/options", { action: "register", code }, { origin: ORIGIN })).status).toBe(403);
  const recovered = await f.finish(setup); expect(recovered.status).toBe(200);
  expect((await recovered.json()).clients).toHaveLength(1);
  expect(f.auth.client(credential.clientId)).not.toBeNull(); expect(f.generation()).toBe(1);
  expect((await f.finish(oldProof)).status).toBe(403);
  expect((await f.send("/auth/pair/poll", { requestId: pending.requestId, pollSecret: pending.pollSecret })).status).toBe(403);
  expect((await f.send("/api/shared/document.read", {}, { authorization: `Bearer ${credential.token}` })).status).toBe(200);
});

test("revocation ends only its client and closes existing reader resources", async () => {
  let closed = 0;
  const f = fixture({ reader: { open: async () => ({ request: async () => new Response("body"), close: async () => { closed++; } }) } });
  const first = await f.enroll(), second = await f.enroll();
  expect((await f.send("/reader/d/document/", undefined, { authorization: `Bearer ${first.token}` })).status).toBe(200);
  const proof = await f.options({ action: "revoke", clientId: first.clientId }); expect((await f.finish(proof)).status).toBe(200);
  expect(closed).toBe(1); expect(f.auth.client(first.clientId)).toBeNull(); expect(f.auth.client(second.clientId)).not.toBeNull();
  expect((await f.send("/api/shared/document.read", {}, { authorization: `Bearer ${first.token}` })).status).toBe(401);
});

test("reader requests strip credentials, retain full operation bodies and preserve structured errors", async () => {
  const f = fixture({ reader: { open: async () => ({ request: async (resource, request) => {
    expect(request.headers.get("authorization")).toBeNull(); expect(request.headers.get("cookie")).toBeNull();
    return Response.json({ resource, body: await request.json() }, { headers: { "set-cookie": "private=forbidden" } });
  }, close: async () => {} }) }, dispatch: async () => { throw Object.assign(new Error("Stale body"), { code: "revision_conflict", status: 409, details: { expected: "old", actual: "new" } }); } });
  const client = await f.enroll(), authorization = `Bearer ${client.token}`;
  const result = await f.send("/reader/d/document/api/file?version=2", { body: "edit", actor: "assistant" }, { authorization }, "PUT");
  expect(result.status).toBe(200); expect(result.headers.get("set-cookie")).toBeNull();
  expect(await result.json()).toMatchObject({ resource: "api/file?version=2", body: { body: "edit", actor: "assistant" } });
  const conflict = await f.send("/api/shared/document.save", {}, { authorization });
  expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: "revision_conflict", details: { actual: "new" } } });
});

test("archived reader asks before restoring the same identity", async () => {
  let archived = true, restores = 0;
  const f = fixture({ reader: { open: async () => { if (archived) throw Object.assign(new Error("archived"), { code: "restore_required" }); return { request: async () => new Response("restored"), close: async () => {} }; } }, dispatch: async (operation, body) => { expect(operation).toBe("document.restore"); expect(body.documentId).toBe("same-id"); archived = false; restores++; return {}; } });
  const client = await f.enroll(), authorization = `Bearer ${client.token}`;
  const prompt = await f.send("/reader/d/same-id/", undefined, { authorization });
  expect(prompt.status).toBe(409); expect(await prompt.text()).toContain("This document has been archived. Restore it?"); expect(restores).toBe(0);
  const restored = await f.send("/reader/d/same-id/restore", {}, { authorization, origin: ORIGIN });
  expect(restored.headers.get("location")).toBe("/reader/d/same-id/"); expect(restores).toBe(1);
  expect(await (await f.send("/reader/d/same-id/", undefined, { authorization })).text()).toBe("restored");
});

test("browser shell receives a nonce and upstream remote redirects are rejected", async () => {
  const f = fixture({ reader: { open: async () => ({ request: async resource => resource === "" ? new Response('<script type="module">console.log(1)</script>', { headers: { "content-type": "text/html" } }) : new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }), close: async () => {} }) } });
  const client = await f.enroll(), headers = { authorization: `Bearer ${client.token}` };
  const shell = await f.send("/reader/d/document/", undefined, headers);
  expect(shell.headers.get("content-security-policy")).toContain("'nonce-"); expect(await shell.text()).toContain('nonce="');
  expect((await f.send("/reader/d/document/api/link", undefined, headers)).status).toBe(502);
});

test("new navigation observes archive while an already-open reader continues", async () => {
  let archived = false;
  const f = fixture({ reader: { open: async () => {
    if (archived) throw Object.assign(new Error("archived"), { code: "restore_required" });
    return { request: async () => Response.json({ readable: true }), close: async () => {} };
  } } });
  const client = await f.enroll(), headers = { authorization: `Bearer ${client.token}` };
  expect((await f.send("/reader/d/document/", undefined, headers)).status).toBe(200);
  archived = true;
  expect((await f.send("/reader/d/document/api/file", undefined, headers)).status).toBe(200);
  expect((await f.send("/reader/d/document/", undefined, headers)).status).toBe(409);
});

test("revocation during an awaited reader response denies its result", async () => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ reader: { open: async () => ({ request: async () => { started(); await blocked; return Response.json({ private: true }); }, close: async () => {} }) } });
  const client = await f.enroll(), pending = f.send("/reader/d/document/api/file", undefined, { authorization: `Bearer ${client.token}` });
  await entered; f.auth.revoke(client.clientId); release();
  const response = await pending; expect(response.status).toBe(401); expect(await response.text()).not.toContain('"private"');
});

test("reader resource eviction permits continued browsing and preserves archived reader access", async () => {
  const archived = new Set<string>(), active = new Set<number>();
  const opened: Array<{ id: string; resume: boolean }> = [];
  let serial = 0;
  const f = fixture({ reader: { open: async (id, options) => {
    opened.push({ id, resume: options?.resume === true });
    if (archived.has(id) && !options?.resume) throw Object.assign(new Error("archived"), { code: "restore_required", status: 409 });
    const resource = ++serial; active.add(resource);
    return { request: async () => Response.json({ id }), close: async () => { active.delete(resource); } };
  } } });
  const client = await f.enroll(), headers = { authorization: `Bearer ${client.token}` };
  expect((await f.send("/reader/d/doc-0/", undefined, headers)).status).toBe(200);
  archived.add("doc-0");
  for (let index = 1; index < 40; index++) {
    expect((await f.send(`/reader/d/doc-${index}/`, undefined, headers)).status).toBe(200);
    expect(active.size).toBeLessThanOrEqual(32);
  }
  const resumed = await f.send("/reader/d/doc-0/api/file", undefined, headers);
  expect(resumed.status).toBe(200); expect(await resumed.json()).toEqual({ id: "doc-0" });
  expect(opened.at(-1)).toEqual({ id: "doc-0", resume: true });
  expect((await f.send("/reader/d/doc-0/", undefined, headers)).status).toBe(409);
  archived.add("never-opened");
  expect((await f.send("/reader/d/never-opened/api/file", undefined, headers)).status).toBe(409);
  expect(opened.at(-1)).toEqual({ id: "never-opened", resume: false });
  await f.gateway.close(); expect(active.size).toBe(0);
});

test("new reader navigation refreshes the location grant while older requests remain fenced", async () => {
  let locationVersion = 1, closed = 0;
  const f = fixture({ reader: { open: async () => {
    const bound = locationVersion;
    return { request: async (_resource, request) => {
      const expected = request.headers.get("x-tether-location-version");
      if (bound !== locationVersion || expected !== null && Number(expected) !== bound) throw Object.assign(new Error("Location changed"), { code: "stale_location", status: 409 });
      return Response.json({ locationVersion: bound });
    }, close: async () => { closed++; } };
  } } });
  const client = await f.enroll(), headers = { authorization: `Bearer ${client.token}` };
  expect(await (await f.send("/reader/d/document/", undefined, headers)).json()).toEqual({ locationVersion: 1 });
  locationVersion = 2;
  expect((await f.send("/reader/d/document/api/file", undefined, headers)).status).toBe(409);
  expect(await (await f.send("/reader/d/document/", undefined, headers)).json()).toEqual({ locationVersion: 2 });
  expect(closed).toBe(1);
  expect((await f.send("/reader/d/document/api/file", {}, { ...headers, "x-tether-location-version": "1" }, "PUT")).status).toBe(409);
  expect((await f.send("/reader/d/document/api/file", {}, { ...headers, "x-tether-location-version": "2" }, "PUT")).status).toBe(200);
});

test("concurrent navigations close each displaced reader resource", async () => {
  const releases: Array<() => void> = [], closed: number[] = [];
  const f = fixture({ reader: { open: async () => {
    const index = releases.length;
    await new Promise<void>(resolve => { releases.push(resolve); });
    return { request: async () => Response.json({ index }), close: async () => { closed.push(index); } };
  } } });
  const client = await f.enroll(), headers = { authorization: `Bearer ${client.token}` };
  const first = f.send("/reader/d/document/", undefined, headers);
  const second = f.send("/reader/d/document/", undefined, headers);
  await Promise.resolve();
  expect(releases).toHaveLength(2);
  releases[0]!(); expect((await first).status).toBe(200);
  releases[1]!(); expect((await second).status).toBe(200);
  expect(closed).toEqual([0]);
  await f.gateway.close(); expect(closed.sort()).toEqual([0, 1]);
});

test("shared responses preserve restrictive image CSP without granting script nonces", async () => {
  const policy = "default-src 'none'; sandbox";
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><script type="module">alert(1)</script></svg>';
  const f = fixture({ reader: { open: async () => ({
    request: async () => new Response(source, { headers: { "content-type": "image/svg+xml", "content-security-policy": policy } }),
    close: async () => {},
  }) } });
  const client = await f.enroll();
  const response = await f.send("/reader/d/document/api/image?src=image.svg", undefined, { authorization: `Bearer ${client.token}` });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe(policy);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe(source);
});


test("approved pairing survives restart and recovers the same credential without plaintext storage", async () => {
  const f = fixture(), pair = await f.pair(); await f.approve(pair);
  const credential = (await (await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).json()).credential;
  const restarted = new SharedAuth({ db: f.db, passkeys: f.passkeys, origin: ORIGIN });
  const response = await restarted.handle(new Request(`${ORIGIN}/auth/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: pair.requestId, pollSecret: pair.pollSecret }) }));
  expect((await response!.json()).credential).toEqual(credential);
  const stored = JSON.stringify(f.db.query("SELECT * FROM ceremonies").all());
  for (const secret of [credential.token, pair.pollSecret, pair.code]) expect(stored).not.toContain(secret);
  restarted.revoke(credential.clientId);
  await expect(restarted.handle(new Request(`${ORIGIN}/auth/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: pair.requestId, pollSecret: pair.pollSecret }) }))).rejects.toThrow();
});

test("global disable invalidates pending issuance and old sessions while retaining sign-in methods", async () => {
  const f = fixture(), pair = await f.pair(); await f.approve(pair); const cookie = await f.login();
  await f.auth.setPassword("a unique owner passphrase 9348");
  f.auth.setEnabled(false);
  expect(f.auth.password.configured()).toBe(true);
  expect((await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).status).toBe(403);
  f.auth.setEnabled(true);
  expect((await f.send("/auth/pair/poll", { requestId: pair.requestId, pollSecret: pair.pollSecret })).status).toBe(403);
  expect((await f.send("/api/shared/document.read", {}, { cookie, origin: ORIGIN })).status).toBe(401);
});

test("password fallback is owner-configured, throttled across restart, and issues distinct browser sessions", async () => {
  const f = fixture(), password = "correct horse personal phrase 9482";
  expect((await f.send("/auth/password/set", { password }, { origin: ORIGIN })).status).toBe(403);
  const agent = await f.enroll();
  expect((await f.send("/auth/password/set", { password }, { origin: ORIGIN, authorization: `Bearer ${agent.token}` })).status).toBe(403);
  await f.auth.setPassword(password);
  expect(JSON.stringify(f.db.query("SELECT * FROM owner_password").all())).not.toContain(password);
  expect((await f.send("/auth/password/login", { password: "wrong" }, { origin: ORIGIN })).status).toBe(403);
  expect((await f.send("/auth/password/login", { password }, { origin: ORIGIN })).status).toBe(429);
  const restarted = new SharedAuth({ db: f.db, passkeys: f.passkeys, origin: ORIGIN });
  await expect(restarted.password.verify(password)).rejects.toThrow("wait");
  f.advance(2000);
  const first = await f.send("/auth/password/login", { password, name: "Browser one" }, { origin: ORIGIN });
  const second = await f.send("/auth/password/login", { password, name: "Browser two" }, { origin: ORIGIN });
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  expect(first.headers.get("set-cookie")).not.toBe(second.headers.get("set-cookie"));
  expect(first.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Strict");
});

test("machine revocation includes explicitly associated agents without affecting browsers or another machine", async () => {
  const f = fixture(), connector = await f.enroll("connector"), browser = await f.login(), independent = await f.enroll();
  const pending = await (await f.send("/auth/pair", { kind: "agent", name: "Paseo", machineId: connector.machineId })).json(); await f.approve(pending);
  const agent = (await (await f.send("/auth/pair/poll", { requestId: pending.requestId, pollSecret: pending.pollSecret })).json()).credential;
  expect(f.auth.revokeMachine(connector.machineId!)).toEqual(expect.arrayContaining([connector.clientId, agent.clientId]));
  expect(f.auth.client(independent.clientId)).not.toBeNull();
  expect(f.auth.machines.get(connector.machineId!)).toBeDefined();
  expect((await f.send("/api/shared/document.read", {}, { cookie: browser, origin: ORIGIN })).status).toBe(200);
});
