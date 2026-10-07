import { SharedAccessError, SharedAuth, sharedJson, type SharedClient } from "./shared-auth";
import { escapeHtml, page } from "./pages";
import type { ReaderBackend, ReaderConnection } from "./contracts";
import { randomBytes } from "node:crypto";

export type SharedGatewayOptions = {
  auth: SharedAuth;
  dispatch: (operation: string, input: Record<string, unknown>, client: SharedClient) => Promise<unknown>;
  reader?: ReaderBackend;
  extension?: (request: Request, client: SharedClient) => Promise<Response | null>;
  authJavaScript?: string;
  setup?: (request: Request) => Promise<Response | null>;
};
function redirect(location: string) { return new Response(null, { status: 303, headers: { location } }); }
function html(body: string, status = 200) { return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }); }
function authPage(path: string, requestId: string, destination: string, passwordConfigured = false): Response {
  let next = "/folio";
  try {
    const candidate = new URL(destination, "https://return.invalid");
    if (candidate.origin === "https://return.invalid" && /^(?:\/reader\/d\/[a-f0-9-]{36}\/|\/settings\/?|\/folio\/?)$/i.test(candidate.pathname)
      && [...candidate.searchParams.keys()].every(key => ["embedded", "themeClient"].includes(key)) && !candidate.hash) next = candidate.pathname + candidate.search;
  } catch {}
  let title = "Sign in to Tether", body = `<label>Device name <input id="name" value="Browser" maxlength="100"></label><button id="login" data-next="${escapeHtml(next)}">Verify with owner passkey</button>`;
  if (path === "/auth/enroll") {
    title = "Set up your owner passkey";
    body = '<p>Enter the one-use code from the local setup or recovery command on your service machine.</p><label>Setup code <input id="code" type="password" autocomplete="off"></label><button id="register">Create owner passkey</button>';
  } else if (path === "/auth/approve") {
    title = "Authorize a Tether client";
    body = `<p id="context" data-request="${escapeHtml(requestId)}">Loading request…</p><label>Code shown on the requesting client <input id="code" autocomplete="off" maxlength="12"></label><button id="approve">Approve with owner passkey</button>`;
  } else if (path === "/auth/clients") {
    title = "Authorized clients";
    body = '<p>Verify with your owner passkey to review authorized clients.</p><button id="list">Review clients</button>';
  }
  if (path === "/auth/login" && passwordConfigured) body += `<details><summary>Use a password instead</summary><label>Password <input id="password" type="password" autocomplete="current-password" maxlength="128"></label><button id="password-login" data-next="${escapeHtml(next)}">Sign in</button></details>`;
  return html(page(title, `${body}<p id="status" role="status"></p><div id="clients"></div><p><a href="/folio">Open Folio</a> · <a href="/auth/clients">Authorized clients</a></p><script type="module" src="/auth/shared.js"></script>`));
}

/** Public HTTPS application boundary; local daemon control routes are never forwarded. */
export class SharedGateway {
  private readonly connections = new Map<string, { clientId: string; connection: Promise<ReaderConnection>; abort: AbortController; lastUsed: number; users: number }>();
  private readonly grants = new Map<string, Set<string>>();
  private readonly unsubscribe: () => void;
  constructor(private readonly options: SharedGatewayOptions) {
    this.unsubscribe = options.auth.onRevoke(id => this.closeClient(id));
  }
  private closeClient(id: string): void {
    this.grants.delete(id);
    for (const [key, value] of this.connections) if (value.clientId === id) {
      this.connections.delete(key); value.abort.abort(); void value.connection.then(connection => connection.close()).catch(() => {});
    }
  }
  async close(): Promise<void> {
    this.unsubscribe();
    const closing = [...this.connections.values()].map(async value => { value.abort.abort(); await (await value.connection).close(); });
    this.connections.clear(); this.grants.clear(); await Promise.allSettled(closing);
  }
  private async secure(response: Response, request?: Request): Promise<Response> {
    const headers = new Headers(response.headers);
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer"); headers.set("x-content-type-options", "nosniff"); headers.set("x-frame-options", "DENY");
    headers.set("strict-transport-security", "max-age=31536000");
    let body: BodyInit | null = response.body, scriptPolicy = "'self'";
    const path = request ? new URL(request.url).pathname : "";
    const themeClient = request ? new URL(request.url).searchParams.get("themeClient") : null;
    if (themeClient && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(themeClient) && /^(?:\/(?:folio|settings)\/?|\/reader\/d\/[^/]+\/)$/.test(path)) headers.append("set-cookie", `__Host-tether-shared-theme=${themeClient}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    // Only trusted application shells contain generated inline modules. Never nonce document content or asset responses.
    if ((/^\/(?:folio|settings)\/?$/.test(path) || /^\/reader\/d\/[^/]+\/$/.test(path)) && headers.get("content-type")?.startsWith("text/html")) {
      const nonce = randomBytes(24).toString("base64url");
      body = (await response.text()).replaceAll('<script type="module">', `<script type="module" nonce="${nonce}">`);
      scriptPolicy += ` 'nonce-${nonce}'`; headers.delete("content-length");
    }
    if (!headers.has("content-security-policy")) headers.set("content-security-policy", `default-src 'none'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    return new Response(body, { status: response.status, headers });
  }
  async handle(request: Request): Promise<Response> {
    try { return await this.secure(await this.route(request), request); }
    catch (cause) {
      const error = cause as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
      const known = typeof error?.code === "string";
      return this.secure(Response.json({ error: {
        code: known ? error.code : "shared_request_failed",
        message: known && typeof error.message === "string" ? error.message : "The shared request could not be completed.",
        ...(known && error.details !== undefined ? { details: error.details } : {}),
      } }, { status: typeof error?.status === "number" && error.status >= 400 && error.status <= 599 ? error.status : known ? 400 : 500 }));
    }
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url), expected = new URL(this.options.auth.origin);
    if (request.headers.get("host") !== expected.host) throw new SharedAccessError("origin_mismatch", "The request host does not match this profile.");
    // Reverse proxy protocol/header claims never provide identity or alter the configured origin.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && requestOrigin !== expected.origin) throw new SharedAccessError("origin_mismatch", "The browser origin does not match this profile.");
    if (request.method === "GET" && url.pathname === "/auth/shared.js") return new Response(this.options.authJavaScript ?? "", { headers: { "content-type": "text/javascript" } });
    if (request.method === "GET" && ["/auth/login", "/auth/enroll", "/auth/approve", "/auth/clients"].includes(url.pathname)) return authPage(url.pathname, url.searchParams.get("request") ?? "", url.searchParams.get("next") ?? "", this.options.auth.password.configured());
    if (url.pathname.startsWith("/auth/")) return await this.options.auth.handle(request) ?? new Response(null, { status: 404 });
    if (url.pathname.startsWith("/setup/") && this.options.auth.enabled()) return await this.options.setup?.(request) ?? new Response(null, { status: 404 });
    const client = this.options.auth.authenticate(request);
    if (!client) {
      if (request.method === "GET" && (url.pathname === "/" || /^\/(?:folio|settings)\/?$/.test(url.pathname) || /^\/reader\/d\/[^/]+\/$/.test(url.pathname))) return redirect(url.pathname === "/folio/" && !url.search || url.pathname === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      throw new SharedAccessError("unauthorized", "Sign in or enroll this client to access the shared profile.", 401);
    }
    if (client.kind === "browser" && !["GET", "HEAD"].includes(request.method) && requestOrigin !== expected.origin) throw new SharedAccessError("origin_mismatch", "Browser mutations require the profile origin.");
    // Expired clients must not leave reader resources alive indefinitely.
    for (const connection of this.connections.values()) if (!this.options.auth.client(connection.clientId)) this.closeClient(connection.clientId);
    if (url.pathname === "/" && request.method === "GET") return redirect("/folio");
    const extension = await this.options.extension?.(request, client);
    if (extension) {
      if (!this.options.auth.client(client.id)) { await extension.body?.cancel(); throw new SharedAccessError("unauthorized", "Client access has ended.", 401); }
      return extension;
    }
    const api = /^\/api\/shared\/([a-z]+(?:[./][a-z-]+)*)$/.exec(url.pathname);
    if (api && request.method === "POST") {
      const result = await this.options.dispatch(api[1]!.replaceAll("/", "."), await sharedJson(request, 18 * 1024 * 1024), client);
      if (!this.options.auth.client(client.id)) throw new SharedAccessError("unauthorized", "Client access has ended.", 401);
      return Response.json(result);
    }
    const reader = /^\/reader\/d\/([A-Za-z0-9_-]+)\/(.*)$/.exec(url.pathname);
    if (reader && this.options.reader) {
      const documentId = reader[1]!, resource = reader[2]!;
      if (resource === "restore" && request.method === "POST") {
        if (requestOrigin !== expected.origin) throw new SharedAccessError("origin_mismatch", "Restoring requires the profile origin.");
        await this.options.dispatch("document.restore", { documentId }, client);
        return redirect(`/reader/d/${documentId}/`);
      }
      // These operate the service machine itself, beyond shared library authority.
      if (/^api\/(updates|service|hosts|file\/reveal)(?:\/|$)/.test(resource)) throw new SharedAccessError("unsupported_operation", "This operation is unavailable through the shared reader.", 404);
      const key = `${client.id}:${documentId}`;
      let entry = this.connections.get(key);
      const navigation = request.method === "GET" && resource === "";
      let opened: ReaderConnection | undefined;
      if (navigation) {
        try { opened = await this.options.reader.open(documentId); }
        catch (cause) {
          if ((cause as { code?: string }).code === "restore_required") return html(page("Restore document", `<p>This document has been archived. Restore it?</p><form method="post" action="/reader/d/${documentId}/restore"><button>Restore</button> <a href="/folio">Cancel</a></form>`), 409);
          throw cause;
        }
        entry = this.connections.get(key);
        if (entry) { this.connections.delete(key); entry.abort.abort(); void entry.connection.then(connection => connection.close()).catch(() => {}); entry = undefined; }
      }
      if (!entry) {
        while (this.connections.size >= 256 || [...this.connections.values()].filter(value => value.clientId === client.id).length >= 32) {
          const overClientLimit = [...this.connections.values()].filter(value => value.clientId === client.id).length >= 32;
          const oldest = [...this.connections.entries()].filter(([, value]) => value.users === 0 && (!overClientLimit || value.clientId === client.id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (!oldest) { await opened?.close(); throw new SharedAccessError("reader_busy", "Other readers are busy. Retry shortly.", 429); }
          this.connections.delete(oldest[0]); oldest[1].abort.abort(); void oldest[1].connection.then(connection => connection.close()).catch(() => {});
        }
        entry = { clientId: client.id, abort: new AbortController(), lastUsed: Date.now(), users: 0,
          connection: opened ? Promise.resolve(opened) : this.options.reader.open(documentId, { resume: this.grants.get(client.id)?.has(documentId) === true }) };
        this.connections.set(key, entry);
        entry.connection.catch(() => { if (this.connections.get(key) === entry) this.connections.delete(key); });
      }
      const connection = await entry.connection;
      let grants = this.grants.get(client.id);
      if (!grants) this.grants.set(client.id, grants = new Set());
      grants.add(documentId);
      if (!this.options.auth.client(client.id)) { this.closeClient(client.id); throw new SharedAccessError("unauthorized", "Client access has ended.", 401); }
      entry.lastUsed = Date.now();
      const headers = new Headers(request.headers); headers.delete("authorization"); headers.delete("cookie"); headers.delete("x-tether-shared-theme");
      const theme = (request.headers.get("cookie") ?? "").split(";").map(item => item.trim()).find(item => item.startsWith("__Host-tether-shared-theme="))?.split("=")[1];
      if (theme && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(theme)) headers.set("x-tether-shared-theme", theme);
      entry.users++;
      let response: Response;
      try { response = await connection.request(`${resource}${url.search}`, new Request(request, { headers, signal: AbortSignal.any([request.signal, entry.abort.signal]) })); }
      finally { entry.users--; }
      if (!this.options.auth.client(client.id)) { await response.body?.cancel(); this.closeClient(client.id); throw new SharedAccessError("unauthorized", "Client access has ended.", 401); }
      const outputHeaders = new Headers(response.headers); outputHeaders.delete("set-cookie");
      const location = outputHeaders.get("location");
      if (location && new URL(location, expected.origin).origin !== expected.origin) { await response.body?.cancel(); throw new SharedAccessError("invalid_redirect", "Reader redirects must stay at the shared profile.", 502); }
      return new Response(response.body, { status: response.status, headers: outputHeaders });
    }
    return new Response(null, { status: 404 });
  }
}
