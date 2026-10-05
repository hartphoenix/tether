import { isApplicationAsset } from "../web/bundle";
import { diagramPalette, parseDiagramPalette, type DiagramPalette } from "../shared/diagram-theme";
import { builtInDesign } from "../shared/themes";
import { createHash, randomBytes } from "node:crypto";
import type { IdentifyCaller, ReaderBackend, ReaderConnection, RemoteDocument } from "./contracts";
import type { PasskeyProvider } from "./passkeys";
import { approvalPage, enrollmentPage, page } from "./pages";
import { documentDiagrams } from "./document-diagrams";
import type { DiagramRenderer } from "./diagram-renderer";

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const BIND = "__Host-tether-phone-binding", SESSION = "__Host-tether-phone";
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
function getCookie(request: Request, name: string) {
  const found = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  return found.length === 1 ? found[0]!.slice(name.length + 1) : "";
}
function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("An exact HTTPS origin is required.");
  return url;
}
async function boundedText(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required.");
  let length = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length; if (length > limit) { await reader.cancel(); throw new Error("Body too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString();
}
async function jsonBody(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON required.");
  const result = JSON.parse(await boundedText(request, 131072));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Object required.");
  return result;
}
type Pending = { principal: string; binding: string; expires: number };
type Challenge = { challenge: string; purpose: "register" | "login" | "revoke"; requestId?: string; principal: string; expires: number };
type PhoneSession = { principal: string; expires: number; connection: ReaderConnection; documents: Map<string, Promise<{ connection: ReaderConnection; document: RemoteDocument }>>; abort: AbortController };

export type PhoneGatewayOptions = {
  readerOrigin: string; approvalOrigin: string; owner: string; document: RemoteDocument;
  identify: IdentifyCaller; passkeys: PasskeyProvider; backend: ReaderBackend;
  authJavaScript: string; now?: () => number; sessionMs?: number;
  diagrams?: DiagramRenderer;
  diagramPalette?: () => DiagramPalette;
};

/** In-memory leases are deliberately lost on restart. No agent authority is issued here. */
export class PhoneGateway {
  private compressedAssets = new Map<string, Uint8Array<ArrayBuffer>>();
  private reader: URL; private approval: URL; private now: () => number;
  private pending = new Map<string, Pending>();
  private challenges = new Map<string, Challenge>();
  private handoffs = new Map<string, Pending>();
  private sessions = new Map<string, PhoneSession>();
  private enrollment?: { digest: string; expires: number };
  private epoch = 0;
  private timer: ReturnType<typeof setInterval>;
  private options: PhoneGatewayOptions;
  constructor(options: PhoneGatewayOptions) {
    this.reader = origin(options.readerOrigin); this.approval = origin(options.approvalOrigin);
    if (this.reader.origin === this.approval.origin) throw new Error("Approval must have a separate origin.");
    // Cookies are not port-isolated. Use dedicated hostnames, never other services' hosts.
    if (this.reader.hostname === this.approval.hostname) throw new Error("Reader and approval require separate dedicated hostnames.");
    if (!options.owner.trim() || !options.document.id || !options.document.title) throw new Error("Owner and document required.");
    this.options = { ...options, document: Object.freeze({ ...options.document }) };
    this.now = options.now ?? Date.now;
    if (options.sessionMs !== undefined && (!Number.isSafeInteger(options.sessionMs) || options.sessionMs <= 0 || options.sessionMs > 3_600_000)) throw new Error("Session duration must be at most one hour.");
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  /** Call only from an explicit local owner setup ceremony; never an HTTP route. */
  beginEnrollment(): string {
    if (this.options.passkeys.enrolled()) throw new Error("A passkey is already enrolled.");
    const code = token(); this.enrollment = { digest: hash(code), expires: this.now() + 300000 }; return code;
  }
  private expire() {
    for (const map of [this.pending, this.challenges, this.handoffs]) {
      for (const [key, item] of map) if (item.expires <= this.now()) map.delete(key);
    }
    for (const [key, item] of this.sessions) if (item.expires <= this.now()) this.end(key);
  }
  private end(key: string) {
    const session = this.sessions.get(key); this.sessions.delete(key);
    if (session) { session.abort.abort(); void session.connection.close().catch(() => {});
      for (const pending of session.documents.values()) void pending.then(item => item.connection.close()).catch(() => {}); }
  }
  revokeAll() {
    this.epoch++;
    this.pending.clear(); this.challenges.clear(); this.handoffs.clear(); this.enrollment = undefined;
    for (const key of this.sessions.keys()) this.end(key);
  }
  close() { clearInterval(this.timer); this.revokeAll(); }
  private headers(response: Response, approval: boolean) {
    const headers = new Headers(response.headers);
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "strict-origin");
    headers.set("x-content-type-options", "nosniff"); headers.set("x-frame-options", "DENY");
    const policy = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${approval ? this.reader.origin : this.approval.origin}`;
    if (headers.has("content-security-policy")) headers.append("content-security-policy", policy);
    else headers.set("content-security-policy", policy);
    return new Response(response.body, { status: response.status, headers });
  }
  private denied(status = 403) { return Response.json({ error: { code: "phone_access_denied", message: "Access denied or expired. Open the private reader address to sign in again." } }, { status }); }
  private beginLogin() {
    if (this.pending.size >= 32) return this.denied(429);
    const id = token(), binding = token();
    this.pending.set(id, { principal: this.options.owner, binding: hash(binding), expires: this.now() + 300000 });
    return this.redirect(`${this.approval.origin}/?request=${id}`, { "set-cookie": cookie(BIND, binding, 300) });
  }
  private transportDenied(request: Request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" || !request.headers.get("accept")?.includes("text/html") || !["/", "/reader/"].includes(path)) return this.denied();
    return new Response(page("Private connection required", `<p>Tether could not verify your Tailscale identity. Check that Tailscale is connected with your account, then try again.</p><p><a href="${this.reader.origin}/">Return to sign in</a></p>`),
      { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  private html(body: string, headers?: HeadersInit) { return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } }); }
  private redirect(path: string, headers: HeadersInit = {}) { return new Response(null, { status: 303, headers: { location: path, ...headers } }); }
  async handle(request: Request, surface: "reader" | "approval"): Promise<Response> {
    this.expire();
    const expected = surface === "reader" ? this.reader : this.approval;
    let response: Response;
    try {
      const url = new URL(request.url);
      if (request.headers.get("host") !== expected.host) response = this.denied();
      else if (await this.options.identify(request) !== this.options.owner) response = this.transportDenied(request);
      else if (request.method !== "GET" && request.headers.get("origin") !== (surface === "reader" && url.pathname === "/handoff" ? this.approval.origin : expected.origin)) response = this.denied();
      else response = surface === "approval" ? await this.auth(request, url) : await this.read(request, url);
    } catch { response = this.denied(); }
    return this.headers(response, surface === "approval");
  }
  private async auth(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (request.method === "GET") {
      if (path === "/auth.js") return new Response(this.options.authJavaScript, { headers: { "content-type": "text/javascript" } });
      if (path === "/enroll") return this.html(enrollmentPage());
      if (path !== "/") return this.denied(404);
      const id = url.searchParams.get("request") ?? "";
      if (id) return this.pending.has(id)
        ? this.html(approvalPage(id, this.options.document.title, this.options.passkeys.enrolled()))
        : this.redirect(`${this.reader.origin}/`);
      return this.html(page("Tether phone access", `<p>Verify with your passkey to end all phone sessions and cancel pending requests.</p><button id="authenticate" data-request="revoke">End all sessions</button><p id="status" role="status"></p><script type="module" src="/auth.js"></script>`));
    }
    if (request.method !== "POST" || !["/registration/options", "/registration/verify", "/authentication/options", "/authentication/verify"].includes(path)) return this.denied(404);
    const body = await jsonBody(request);
    if (path.endsWith("/options")) {
      if (this.challenges.size >= 32) return this.denied(429);
      const epoch = this.epoch;
      let options; let purpose: Challenge["purpose"]; let requestId: string | undefined;
      if (path.startsWith("/registration")) {
        if (!this.enrollment || this.enrollment.expires <= this.now() || typeof body.code !== "string" || hash(body.code) !== this.enrollment.digest) return this.denied();
        this.enrollment = undefined; purpose = "register";
        options = await this.options.passkeys.registrationOptions();
      } else {
        requestId = body.requestId;
        if (requestId === "revoke") purpose = "revoke";
        else if (typeof requestId === "string" && this.pending.has(requestId)) purpose = "login";
        else return this.denied();
        options = await this.options.passkeys.authenticationOptions();
      }
      if (epoch !== this.epoch || this.challenges.size >= 32) return this.denied();
      const id = token();
      this.challenges.set(id, { challenge: options.challenge, purpose, requestId, principal: this.options.owner, expires: this.now() + 120000 });
      return Response.json({ id, options });
    }
    const challenge = this.challenges.get(body.challengeId);
    this.challenges.delete(body.challengeId); // Consume before asynchronous verification, including failures.
    if (!challenge || challenge.expires <= this.now()) return this.denied();
    if (path === "/registration/verify") {
      if (challenge.purpose !== "register") return this.denied();
      await this.options.passkeys.register(challenge.challenge, body.response);
      return Response.json({ enrolled: true });
    }
    if (challenge.purpose === "register") return this.denied();
    await this.options.passkeys.authenticate(challenge.challenge, body.response);
    if (challenge.purpose === "revoke") { this.revokeAll(); return Response.json({ revoked: true }); }
    const pending = this.pending.get(challenge.requestId!); this.pending.delete(challenge.requestId!);
    if (!pending || pending.expires <= this.now()) return this.denied();
    const code = token(); this.handoffs.set(hash(code), { ...pending, expires: Math.min(pending.expires, this.now() + 30000) });
    return Response.json({ action: `${this.reader.origin}/handoff`, code });
  }
  private async read(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/handoff" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return this.denied();
      const text = await boundedText(request, 512);
      const code = new URLSearchParams(text).get("code") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return this.denied();
      // Complete a same-origin POST after navigation, so Strict binding cookies work cross-site.
      return this.html(page("Opening reader", `<form id="handoff" method="post" action="/accept"><input type="hidden" name="code" value="${code}"><button>Continue</button></form><script src="/handoff.js"></script>`));
    }
    if (path === "/handoff.js" && request.method === "GET") return new Response('document.getElementById("handoff").submit();', { headers: { "content-type": "text/javascript" } });
    if (path === "/start" && request.method === "POST") return this.beginLogin();
    if (path === "/accept" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return this.denied();
      const text = await boundedText(request, 512);
      const code = new URLSearchParams(text).get("code") ?? "";
      const pending = this.handoffs.get(hash(code)); this.handoffs.delete(hash(code));
      if (!pending || pending.expires <= this.now() || pending.binding !== hash(getCookie(request, BIND)) || this.sessions.size >= 16) return this.denied();
      const epoch = this.epoch;
      const connection = await this.options.backend.open(this.options.document.id);
      if (epoch !== this.epoch || pending.expires <= this.now() || this.sessions.size >= 16) { await connection.close(); return this.denied(); }
      const secret = token(), lifetime = this.options.sessionMs ?? 3600000;
      this.sessions.set(hash(secret), { principal: pending.principal, connection, documents: new Map(), expires: this.now() + lifetime, abort: new AbortController() });
      return this.redirect("/reader/", { "set-cookie": cookie(SESSION, secret, Math.floor(lifetime / 1000)) });
    }
    const key = hash(getCookie(request, SESSION)); const session = this.sessions.get(key);
    if (request.method === "GET" && (path === "/" || path === "/reader/")) {
      if (!session) return this.beginLogin();
      if (path === "/") return this.redirect("/reader/");
    }
    if (path === "/logout" && request.method === "POST") { this.end(key); return this.redirect("/", { "set-cookie": cookie(SESSION, "", 0) }); }
    if (!session || session.expires <= this.now()) return this.denied(401);
    if (!path.startsWith("/reader/") && !isApplicationAsset(path)) return this.denied(404);
    let resource = path.startsWith("/assets/") ? path.slice(1) : path.slice("/reader/".length);
    let connection = session.connection, selectedDocument = this.options.document;
    const scoped = /^d\/([^/]+)\/(.*)$/.exec(resource);
    if (scoped) resource = scoped[2]!;
    if (resource === "api/folio" && request.method === "GET") {
      const files = this.options.backend.list ? await this.options.backend.list() : [this.options.document];
      if (!this.sessions.has(key) || session.expires <= this.now()) return this.denied(401);
      return Response.json(files);
    }
    const asset = isApplicationAsset(`/${resource}`) || /^(?:[A-Za-z0-9_-]+\.(?:js|css|woff2?|png)|(?:docs\/)?assets\/tether-banner(?:-tagline)?\.png)$/.test(resource);
    const allowedGet = ["", "api/bootstrap", "api/file", "api/image", "api/annotations", "api/annotations/pending", "api/annotations/thread", "api/preferences"];
    const allowedPost = ["api/changes", "api/lease", "api/release", "api/position", "api/annotations", "api/annotations/reply", "api/annotations/acknowledge"];
    if (!(request.method === "PUT" && resource === "api/preferences") && !(request.method === "GET" && (allowedGet.includes(resource) || asset)) && !(request.method === "POST" && (allowedPost.includes(resource) || resource === "api/diagrams" && this.options.diagrams))) return this.denied();
    if (scoped && resource !== "" && !asset) {
      const id = decodeURIComponent(scoped[1]!);
      if (id !== this.options.document.id) {
        // Revalidate membership on every request, including already-open documents.
        const entry = this.options.backend.member ? await this.options.backend.member(id) : (await this.options.backend.list?.())?.find(file => file.id === id && !file.unavailable);
        if (!entry) return this.denied(404);
        let pending = session.documents.get(id);
        if (!pending) {
          pending = this.options.backend.open(id).then(connection => ({ connection, document: entry }));
          session.documents.set(id, pending);
          void pending.catch(() => session.documents.delete(id));
        }
        const opened = await pending;
        if (!this.sessions.has(key) || session.expires <= this.now()) { await opened.connection.close(); return this.denied(401); }
        connection = opened.connection; selectedDocument = entry;
      }
    }
    const stillAuthorized = async () => {
      if (!this.sessions.has(key) || session.expires <= this.now()) return false;
      if (!scoped || asset || !resource || decodeURIComponent(scoped[1]!) === this.options.document.id) return true;
      const id = decodeURIComponent(scoped[1]!);
      const member = this.options.backend.member ? await this.options.backend.member(id)
        : (await this.options.backend.list?.())?.find(file => file.id === id && !file.unavailable);
      return Boolean(member) && this.sessions.has(key) && session.expires > this.now();
    };
    if (resource === "api/diagrams" && request.method === "POST" && this.options.diagrams) {
      let palette: DiagramPalette;
      try { palette = parseDiagramPalette((await jsonBody(request)).palette); } catch { return this.denied(400); }
      const documentResponse = await connection.request("api/file", new Request(request.url, { signal: AbortSignal.any([session.abort.signal, request.signal]) }));
      if (!documentResponse.ok) return this.denied();
      const document = await documentResponse.json();
      const previews = await documentDiagrams(document.body, this.options.diagrams, palette, request.signal);
      if (!await stillAuthorized()) return this.denied();
      return Response.json(previews);
    }
    let body: string | undefined;
    if (request.method === "POST" || request.method === "PUT") {
      const value = await jsonBody(request);
      if (resource === "api/preferences" && (Object.keys(value).length !== 1 || typeof value.theme !== "string")) return this.denied();
      if (resource === "api/annotations" && value.type !== "comment") return this.denied();
      // Caller assertions are neither identity nor evidence of keyboard approval.
      for (const field of ["principal", "provenance", "inputOrigin", "captureId"]) delete value[field];
      if (resource.startsWith("api/annotations")) { value.actor = "human"; }
      body = JSON.stringify(value);
    }
    const response = await connection.request(`${resource}${url.search}`, new Request(request.url, {
      method: request.method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(request.headers.has("if-none-match") ? { "if-none-match": request.headers.get("if-none-match")! } : {}) }, body,
      signal: AbortSignal.any([session.abort.signal, request.signal]),
    }));
    if (!await stillAuthorized()) return this.denied();
    if (response.status === 304 && resource === "api/file") return new Response(null, { status: 304, headers: { "cache-control": "no-store", ...(response.headers.has("etag") ? { etag: response.headers.get("etag")! } : {}) } });
    if (response.status >= 300 && response.status < 400) return this.denied();
    if (!response.ok) return Response.json({ error: { code: "reader_operation_failed", message: "Reader operation failed. Refresh before retrying." } }, { status: response.status });
    if (response.headers.get("content-type")?.includes("application/json")) {
      const value = await response.json() as any;
      if (!this.sessions.has(key) || session.expires <= this.now()) return this.denied();
      if ("path" in value) { value.path = selectedDocument.title; value.documentId = selectedDocument.id; }
      if (["api/bootstrap", "api/file"].includes(resource)) {
        const document = resource === "api/bootstrap" ? value.document : value;
        document.bodyEditable = false; document.path = selectedDocument.title; document.documentId = selectedDocument.id;
        if (this.options.diagrams) {
          let palette = this.options.diagramPalette?.();
          if (!palette) {
            const preferences = resource === "api/bootstrap" ? value.preferences : await (await connection.request("api/preferences", new Request(request.url, { signal: session.abort.signal }))).json();
            const design = builtInDesign(preferences.theme) ?? preferences.customThemes?.find((theme: any) => theme.id === preferences.theme) ?? builtInDesign("tether-dark")!;
            palette = diagramPalette(design.colors, design.base.endsWith("-dark"));
          }
          document.diagramPalette = palette;
          document.diagramPreviews = await documentDiagrams(document.body, this.options.diagrams, palette, request.signal);
        }
      }
      if (resource === "api/bootstrap") { value.draft = null; value.directoryPicker = false; value.capabilities = {}; value.remoteReader = true; value.updateControls = false; }
      if (!await stillAuthorized()) return this.denied();
      return Response.json(value, { headers: { "cache-control": "no-store", ...(response.headers.has("etag") ? { etag: response.headers.get("etag")! } : {}) } });
    }
    // Never relay upstream cookies, redirects, or arbitrary headers to the phone.
    const headers = new Headers({ "content-type": response.headers.get("content-type") ?? "application/octet-stream" });
    for (const name of ["content-security-policy", "cross-origin-resource-policy"]) {
      const value = response.headers.get(name); if (value) headers.set(name, value);
    }
    if (asset) {
      // Drain loopback before sending over a slow network: the upstream request's
      // timeout must not cut off a large stylesheet halfway through delivery.
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!this.sessions.has(key) || session.expires <= this.now()) return this.denied();
      if (/-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|png)$/.test(resource)) {
        // Only content-addressed application assets, never document data.
        headers.set("cache-control", "private, max-age=86400, immutable");
      }
      headers.set("vary", "Accept-Encoding");
      const gzip = (request.headers.get("accept-encoding") ?? "").split(",").some(part => {
        const [encoding, quality] = part.trim().split(";");
        return encoding === "gzip" && (!quality || Number(quality.trim().replace(/^q=/, "")) > 0);
      });
      if (gzip && /\.(?:css|js)$/.test(resource)) {
        headers.set("content-encoding", "gzip");
        const cacheable = isApplicationAsset(`/assets/${resource.split("/").at(-1)}`);
        let compressed = cacheable ? this.compressedAssets.get(resource) : undefined;
        if (!compressed) {
          compressed = Bun.gzipSync(bytes);
          // Bound memory across long-lived sessions and changing development builds.
          if (this.compressedAssets.size >= 512) this.compressedAssets.delete(this.compressedAssets.keys().next().value!);
          if (cacheable) this.compressedAssets.set(resource, compressed);
        }
        return new Response(compressed, { status: response.status, headers });
      }
      return new Response(bytes, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  }
}
