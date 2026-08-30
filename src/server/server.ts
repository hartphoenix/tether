import { basename, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import {
  PROTOCOL_VERSION,
  SERVICE_ID,
  sessionRoutes,
  type AppPreferences,
  type DocumentSnapshot,
} from "../shared/contracts";
import type { HostAdapter } from "../hosts/host-adapter";
import { createBrowserHost } from "../hosts/browser";
import { DocumentService, DocumentConflictError, DocumentReadOnlyError, type AnnotationEventInput, type DocumentSession } from "../documents/document-service";
import { RecentsRegistry } from "../recents/registry";
import { ensureControlToken, prepareConfig, readControlToken, removeDiscovery, resolveConfig, writeDiscovery, type TetherConfig } from "./config";

const LOOPBACK = "127.0.0.1";
const DEFAULT_TICKET_MS = 30_000;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_STARTUP_GRACE_MS = 30_000;
const DEFAULT_IDLE_MS = 5_000;
const DEFAULT_SESSION_GRACE_MS = 5_000;

export type Clock = () => number;
export type Ticket = { ticket: string; url: string; expiresAt: number };
export type Session = { id: string; grant: DocumentSession; cookie: string; createdAt: number; lastSeen: number; leases: Map<string, number>; unleasedSince: number | null };

export type DaemonOptions = {
  config?: TetherConfig;
  port?: number;
  service?: DocumentService;
  recents?: RecentsRegistry;
  hostAdapter?: HostAdapter;
  now?: Clock;
  ticketMs?: number;
  leaseMs?: number;
  startupGraceMs?: number;
  idleMs?: number;
  sessionGraceMs?: number;
  actor?: string;
  /** A production web build can supply the extracted editor response. */
  web?: (request: Request, session: Session) => Response | Promise<Response>;
  opener?: (url: string) => Promise<void>;
};

export type TetherDaemon = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  origin: string;
  instanceId: string;
  config: TetherConfig;
  ready: Promise<void>;
  closed: Promise<void>;
  stop: () => Promise<void>;
  mintTicket: (grant: DocumentSession) => Ticket;
  service: DocumentService;
  sessions: ReadonlyMap<string, Session>;
};

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "content-type": "application/json; charset=utf-8", ...init.headers } });
}

function error(code: string, message: string, status: number, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

export function sameOrigin(request: Request, origin: string): boolean {
  const value = request.headers.get("origin");
  if (value !== null) return value === origin;
  const referer = request.headers.get("referer");
  return referer !== null && (referer === `${origin}/` || referer.startsWith(`${origin}/`));
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const item of cookies) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new Error("Invalid JSON request.");
}

function textBody(body: Record<string, unknown>): string | undefined {
  const value = body.body ?? body.text;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventType(value: unknown): value is AnnotationEventInput["type"] {
  return value === "comment" || value === "reply" || value === "resolve" || value === "reopen" || value === "edit" || value === "delete" || value === "ack";
}

function selectEvent(body: Record<string, unknown>, forcedType?: string): AnnotationEventInput {
  const type = forcedType ?? body.type;
  if (!eventType(type)) throw new Error("Invalid annotation event type.");
  if (typeof body.actor !== "string" || !body.actor.trim()) throw new Error("An asserted actor is required.");
  const event: AnnotationEventInput = { ...body, type, actor: body.actor };
  for (const key of ["path", "expectedBodyRevision", "expectedRevision", "expectedLedgerRevision", "id", "seq", "createdAt", "through", "throughSeq"]) delete event[key];
  if (type !== "ack") delete event.bodyRevision;
  if (type === "ack") {
    const through = body.throughSeq ?? body.through;
    if (typeof through === "number") event.throughSeq = through;
    if (typeof body.bodyRevision === "string") event.bodyRevision = body.bodyRevision;
  }
  return event;
}

function expectedBodyRevision(body: Record<string, unknown>): string | undefined {
  const value = body.expectedBodyRevision ?? body.bodyRevision ?? body.expectedRevision;
  return typeof value === "string" ? value : undefined;
}

function preferencesFrom(value: unknown): AppPreferences {
  const theme = value && typeof value === "object" && typeof (value as Record<string, unknown>).theme === "string" ? (value as Record<string, unknown>).theme : "frame-dark";
  const allowed = new Set<AppPreferences["theme"]>(["frame-dark", "crepe-dark", "nord-dark", "frame", "crepe", "nord"]);
  return { theme: allowed.has(theme as AppPreferences["theme"]) ? theme as AppPreferences["theme"] : "frame-dark" };
}

const fallbackHtml = `<!doctype html><meta charset="utf-8"><title>Tether</title><main id="app">Tether session</main>`;

/**
 * Create one loopback daemon. The document and Recents dependencies are
 * intentionally narrow so the lead can replace the filesystem fallback with
 * the extracted product services without changing this HTTP boundary.
 */
export function createDaemon(options: DaemonOptions = {}): TetherDaemon {
  const config = options.config ?? resolveConfig();
  const now = options.now ?? Date.now;
  const ticketMs = options.ticketMs ?? DEFAULT_TICKET_MS;
  const leaseMs = options.leaseMs ?? Number(process.env.TETHER_LEASE_MS ?? DEFAULT_LEASE_MS);
  const startupGraceMs = options.startupGraceMs ?? Number(process.env.TETHER_STARTUP_GRACE_MS ?? DEFAULT_STARTUP_GRACE_MS);
  const idleMs = options.idleMs ?? Number(process.env.TETHER_IDLE_MS ?? DEFAULT_IDLE_MS);
  const sessionGraceMs = options.sessionGraceMs ?? DEFAULT_SESSION_GRACE_MS;
  const service = options.service ?? new DocumentService({ now });
  const recents = options.recents ?? new RecentsRegistry({ path: config.recentsPath, now });
  const hostAdapter = options.hostAdapter ?? createBrowserHost({ open: options.opener });
  const instanceId = crypto.randomUUID();
  const tickets = new Map<string, { grant: DocumentSession; expiresAt: number }>();
  const sessions = new Map<string, Session>();
  const startedAt = now();
  let emptySince = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySettled = false;
  const settleReady = (cause?: unknown) => {
    if (readySettled) return;
    readySettled = true;
    if (cause === undefined) resolveReady(); else rejectReady(cause);
  };

  const originFor = (port: number) => `http://${LOOPBACK}:${port}`;
  let daemon!: TetherDaemon;

  function mintTicket(grant: DocumentSession): Ticket {
    const ticket = randomToken();
    const expiresAt = now() + ticketMs;
    tickets.set(ticket, { grant, expiresAt });
    return { ticket, expiresAt, url: `${daemon.origin}/launch?ticket=${encodeURIComponent(ticket)}` };
  }

  function discardTicket(ticket: string): void {
    const pending = tickets.get(ticket);
    if (!pending) return;
    tickets.delete(ticket);
    service.close(pending.grant);
  }

  function sessionFrom(request: Request, pathname: string): Session | Response {
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return error("invalid_session", "The browser session route is invalid.", 404);
    let id: string;
    try { id = decodeURIComponent(match[1]); } catch { return error("invalid_session", "The browser session route is invalid.", 404); }
    const session = sessions.get(id);
    if (!session) return error("session_expired", "The browser session has expired.", 401);
    if (cookieValue(request, "tether_session") !== session.cookie) return error("unauthorized", "A scoped browser session cookie is required.", 401);
    session.lastSeen = now();
    return session;
  }

  async function preferences(): Promise<AppPreferences> {
    try { return preferencesFrom(JSON.parse(await readFile(config.preferencesPath, "utf8"))); } catch { return preferencesFrom(null); }
  }

  async function sessionApi(request: Request, session: Session, path: string): Promise<Response> {
    const apiPath = path.replace(/^\/s\/[^/]+\/api/, "") || "/";
    const stateChanging = request.method !== "GET" && request.method !== "HEAD";
    if (stateChanging && !sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
    try {
      if (apiPath === "/bootstrap" && request.method === "GET") {
        const document = await service.read(session.grant);
        return json({ protocol: PROTOCOL_VERSION, sessionId: session.id, document, capabilities: hostAdapter.capabilities(), preferences: await preferences(), actor: options.actor ?? "assistant" });
      }
      if (apiPath === "/file" && request.method === "GET") return json(await service.read(session.grant));
      if (apiPath === "/export" && request.method === "GET" || apiPath === "/file/export" && request.method === "GET") {
        const { document, source } = await service.readExactSnapshot(session.grant);
        if (document.readOnly) return error("ledger_invalid", document.ledgerError ?? "The document ledger is malformed.", 422);
        return new Response(source, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${basename(session.grant.path).replaceAll('"', "")}"` } });
      }
      if (apiPath === "/file" && request.method === "PUT") {
        const body = await requestJson(request);
        const content = typeof body.content === "string" ? body.content : typeof body.body === "string" ? body.body : undefined;
        const expected = expectedBodyRevision(body);
        if (content === undefined || !expected) return error("invalid_request", "A body and expectedBodyRevision are required.", 400);
        return json(await service.saveBody({ session: session.grant, body: content, expectedBodyRevision: expected }));
      }
      if (apiPath === "/annotations" && request.method === "GET") {
        const actor = new URL(request.url).searchParams.get("actor") ?? options.actor ?? "assistant";
        const pending = await service.pendingRead(session.grant, actor);
        return json(pending);
      }
      if (apiPath === "/annotations/pending" && (request.method === "GET" || request.method === "POST")) {
        const body = request.method === "POST" ? await requestJson(request) : {};
        const actor = typeof body.actor === "string" ? body.actor : new URL(request.url).searchParams.get("actor") ?? options.actor ?? "assistant";
        return json(await service.pendingRead(session.grant, actor));
      }
      if (apiPath === "/annotations/thread" && request.method === "GET") {
        const threadId = new URL(request.url).searchParams.get("threadId") ?? new URL(request.url).searchParams.get("id");
        if (!threadId) return error("invalid_request", "A thread ID is required.", 400);
        return json(await service.thread(session.grant, threadId));
      }
      const action = /^\/annotations\/(reply|resolve|reopen|edit|delete|acknowledge)$/.exec(apiPath)?.[1];
      if (action && request.method === "POST") {
        const body = await requestJson(request);
        let event: AnnotationEventInput;
        if (action === "reply") {
          if (!textBody(body) || typeof body.threadId !== "string") throw new Error("A reply needs threadId and body.");
          event = selectEvent({ ...body, type: "reply", body: textBody(body) }, "reply");
        } else if (action === "edit") {
          if (!textBody(body) || typeof body.threadId !== "string" || typeof body.targetId !== "string") throw new Error("An edit needs threadId, targetId, and body.");
          event = selectEvent({ ...body, type: "edit", body: textBody(body) }, "edit");
        } else if (action === "delete") {
          if (typeof body.threadId !== "string" || typeof body.targetId !== "string") throw new Error("A delete event needs threadId and targetId.");
          event = selectEvent({ ...body, type: "delete" }, "delete");
        } else if (action === "acknowledge") {
          if (!Number.isSafeInteger(body.through) || (body.through as number) < 1 || typeof body.bodyRevision !== "string") throw new Error("An acknowledgement needs through and bodyRevision.");
          event = selectEvent({ ...body, type: "ack", throughSeq: body.through }, "ack");
        } else {
          if (typeof body.threadId !== "string") throw new Error(`A ${action} event needs threadId.`);
          event = selectEvent({ ...body, type: action }, action);
        }
        return json(await service.appendEvent({ session: session.grant, event, expectedBodyRevision: action === "acknowledge" ? body.bodyRevision as string : expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/annotations" && request.method === "POST") {
        const body = await requestJson(request);
        return json(await service.appendEvent({ session: session.grant, event: selectEvent(body), expectedBodyRevision: expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/lease" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId !== "string" || !body.clientId) return error("invalid_client", "A lease clientId is required.", 400);
        const leaseId = body.clientId;
        session.leases.set(leaseId, now() + leaseMs);
        session.unleasedSince = null;
        emptySince = 0;
        const read = await service.read(session.grant);
        return json({ bodyRevision: read.bodyRevision, ledgerRevision: read.ledgerRevision, revision: read.bodyRevision });
      }
      if (apiPath === "/release" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId === "string") session.leases.delete(body.clientId);
        // A pagehide beacon also fires during an ordinary reload. Keep the
        // scoped session and document grant alive through the daemon's short
        // idle window so the replacement page can bootstrap and lease it
        // again. With no remaining leases the daemon is still free to stop.
        session.lastSeen = now();
        if (session.leases.size === 0) session.unleasedSince = session.lastSeen;
        return json({ ok: true });
      }
      if (apiPath === "/open" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.target !== "string" || !body.target.trim()) throw new Error("A wikilink target is required.");
        const grant = await resolveTarget(session.grant.path, body.target, service);
        const ticket = mintTicket(grant);
        try { await hostAdapter.openView(ticket.url); }
        catch (cause) { discardTicket(ticket.ticket); throw cause; }
        return json({ path: grant.path, resolvedPath: grant.realPath, opened: true });
      }
      if (apiPath === "/preferences" && request.method === "PUT") {
        const body = await requestJson(request);
        const value = preferencesFrom(body);
        const { mkdir, writeFile, rename } = await import("node:fs/promises");
        await mkdir(dirname(config.preferencesPath), { recursive: true, mode: 0o700 });
        const temp = `${config.preferencesPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        await rename(temp, config.preferencesPath);
        return json(value);
      }
      return error("not_found", "API endpoint not found.", 404);
    } catch (cause) {
      const status = cause instanceof DocumentConflictError ? 409 : cause instanceof DocumentReadOnlyError ? 422 : 400;
      return error(status === 409 ? "conflict" : status === 422 ? "ledger_invalid" : "invalid_request", (cause as Error).message || "Request failed.", status);
    }
  }

  async function resolveTarget(currentPath: string, rawTarget: string, documents: DocumentService): Promise<DocumentSession> {
    const resolved = await documents.resolveWikilink(currentPath, rawTarget);
    return documents.open(resolved);
  }

  async function requestHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId });
    if (pathname === "/launch" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket");
      if (!ticket) return error("ticket_missing", "A launch ticket is required.", 400);
      const pending = tickets.get(ticket);
      if (!pending) return error("ticket_invalid", "The launch ticket is invalid or already used.", 401);
      tickets.delete(ticket);
      if (pending.expiresAt <= now()) {
        service.close(pending.grant);
        return error("ticket_expired", "The launch ticket has expired.", 401);
      }
      const id = randomToken();
      const createdAt = now();
      const session: Session = { id, grant: pending.grant, cookie: randomToken(), createdAt, lastSeen: createdAt, leases: new Map(), unleasedSince: createdAt };
      sessions.set(id, session);
      try { await recents.add(pending.grant.realPath); }
      catch (cause) {
        sessions.delete(id);
        service.close(pending.grant);
        return error("launch_failed", cause instanceof Error ? cause.message : String(cause), 500);
      }
      const root = sessionRoutes(id).root;
      return new Response(null, { status: 302, headers: {
        location: root,
        "set-cookie": `tether_session=${session.cookie}; Path=${root}; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      } });
    }
    if (pathname.startsWith("/control/")) {
      const expected = await readControlToken(config);
      if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return error("forbidden", "Control authorization is required.", 403);
      try {
        if (pathname === "/control/launch" && request.method === "POST") {
          const body = await requestJson(request);
          const grant = await service.open(typeof body.path === "string" ? body.path : "");
          const ticket = mintTicket(grant);
          return json({ ...ticket, path: grant.path });
        }
        if (pathname === "/control/cancel" && request.method === "POST") {
          const body = await requestJson(request);
          if (typeof body.ticket !== "string" || !body.ticket) return error("invalid_request", "A launch ticket is required.", 400);
          discardTicket(body.ticket);
          return json({ cancelled: true });
        }
        if (pathname === "/control/status" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId, origin: daemon.origin, pid: process.pid, sessions: sessions.size });
        if (pathname === "/control/stop" && request.method === "POST") { queueMicrotask(() => { void daemon.stop(); }); return json({ stopping: true }); }
      } catch (cause) { return error("invalid_request", (cause as Error).message, 400); }
      return error("not_found", "Control endpoint not found.", 404);
    }
    if (pathname.startsWith("/s/")) {
      const session = sessionFrom(request, pathname);
      if (session instanceof Response) return session;
      const sessionRoot = sessionRoutes(session.id).root;
      const suffix = pathname.slice(sessionRoot.length - 1);
      if (suffix.startsWith("/api/")) return sessionApi(request, session, pathname);
      if (options.web) return options.web(request, session);
      if (suffix === "/" || suffix === "") return new Response(fallbackHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      return error("not_found", "Session resource not found.", 404);
    }
    return error("not_found", "Not found.", 404);
  }

  const bunServer = Bun.serve({ hostname: LOOPBACK, port: options.port ?? 0, fetch: requestHandler });
  const boundPort = bunServer.port!;
  daemon = {
    server: bunServer,
    port: boundPort,
    origin: originFor(boundPort),
    instanceId,
    config,
    service,
    ready,
    closed,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const session of sessions.values()) service.close(session.grant);
      sessions.clear();
      for (const pending of tickets.values()) service.close(pending.grant);
      tickets.clear();
      await bunServer.stop();
      await removeDiscovery(config, instanceId);
      settleReady();
      resolveClosed();
    },
    mintTicket,
    sessions,
  };

  void (async () => {
    try {
      await prepareConfig(config);
      if (stopped) return;
      await ensureControlToken(config);
      if (stopped) return;
      await writeDiscovery(config, { protocol: PROTOCOL_VERSION, instanceId, pid: process.pid, origin: daemon.origin, startedAt: new Date(startedAt).toISOString() });
      if (stopped) { await removeDiscovery(config, instanceId); return; }
      timer = setInterval(() => {
        const current = now();
        for (const session of [...sessions.values()]) {
          for (const [lease, expiry] of session.leases) if (expiry <= current) session.leases.delete(lease);
          if (session.leases.size > 0) {
            session.unleasedSince = null;
            continue;
          }
          session.unleasedSince ??= current;
          if (current - session.unleasedSince >= sessionGraceMs) {
            sessions.delete(session.id);
            service.close(session.grant);
          }
        }
        for (const [ticket, pending] of tickets) {
          if (pending.expiresAt <= current) {
            tickets.delete(ticket);
            service.close(pending.grant);
          }
        }
        const active = [...sessions.values()].some((session) => session.leases.size > 0);
        if (active) { emptySince = 0; return; }
        if (emptySince === 0) emptySince = current;
        const grace = current - startedAt < startupGraceMs ? startupGraceMs : idleMs;
        if (current - emptySince >= grace) void daemon.stop();
      }, 500);
      settleReady();
    } catch (cause) { settleReady(cause); void daemon.stop(); }
  })();

  return daemon;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<TetherDaemon> {
  let configured = options;
  if (!configured.web) {
    const { createWebBundleResponder } = await import("../web/bundle");
    const responder = await createWebBundleResponder();
    configured = { ...options, web: (request) => responder(request) };
  }
  const daemon = createDaemon(configured);
  await daemon.ready;
  return daemon;
}

export async function createLaunchTicket(daemon: TetherDaemon, path: string): Promise<Ticket> {
  return daemon.mintTicket(await daemon.service.open(path));
}
