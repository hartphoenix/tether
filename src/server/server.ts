import { preferencesFrom, updatePreferences } from "../shared/themes";
import { runtimeRoot } from "../runtime-paths";
import { seedWelcome } from "../onboarding";
import { UpdateService } from "./updates";
import { dirname, extname, join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { PrivateStore } from "../storage/private-store";
import { ViewStore, cookieVerifier, verifiesCookie } from "./view-store";
import { anchorForQuote, quoteCandidates } from "./quote-anchor";
import { AgentReads } from "../documents/agent-reads";
import { INPUT_LIMITS, invalidRequest, validateControlInput } from "../shared/control-input";
import { AnnotationLedgerError } from "../core/index";
import { PrivateStoreConflictError, PrivateStoreDocumentNotFoundError } from "../storage/private-store";
import { folioHtml } from "../web/folio-page";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  PROTOCOL_VERSION,
  SERVICE_ID,
  sessionRoutes,
  type AppPreferences,
  type DocumentSnapshot,
} from "../shared/contracts";
import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import { createBrowserHost } from "../hosts/browser";
import { HostGateway } from "../hosts/host-gateway";
import { prepareCmuxBridgeRestart } from "../hosts/cmux-bridge";
import { DocumentService, DocumentAccessError, DocumentConflictError, DocumentNotFoundError, DocumentReadOnlyError, type AnnotationEventInput, type AppendEventInput, type DocumentSession } from "../documents/document-service";
import { chooseImportDirectory } from "./directory-picker";
import { RecentsRegistry, type ListFolioOptions, type FolioRetention } from "../recents/registry";
import { RecentsService, type FolioSnapshot } from "../recents/service";
import { moveToTrash, pickMarkdownFiles } from "../recents/actions";
import { ensureControlToken, prepareConfig, readControlToken, removeDiscovery, resolveConfig, writeDiscovery, type TetherConfig } from "./config";

const LOOPBACK = "127.0.0.1";
const DEFAULT_TICKET_MS = 30_000;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_STARTUP_GRACE_MS = 30_000;
const DEFAULT_IDLE_MS = 5_000;

export type Clock = () => number;
export type Ticket = { ticket: string; url: string; expiresAt: number };
export type Session = { id: string; grant: DocumentSession; cookie: string; verifier?: string; createdAt: number; lastSeen: number; leases: Map<string, number>; target?: HostTarget };
type RecentsSession = { id: string; cookie: string; verifier?: string; createdAt: number; lastSeen: number; leaseUntil: number; target?: HostTarget };

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
  actor?: string;
  restart?: () => Promise<void>;
  update?: (tag: string) => Promise<void>;
  updates?: Pick<UpdateService, "status" | "install" | "dismiss">;
  persistentViews?: boolean;
  /** A production web build can supply the extracted editor response. */
  web?: (request: Request, session: Session) => Response | Promise<Response>;
  opener?: (url: string) => Promise<void>;
  trashFile?: (path: string) => Promise<void>;
  pickFiles?: () => Promise<string[]>;
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
  mintTicket: (grant: DocumentSession, target?: HostTarget) => Ticket;
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

function codedError(cause: unknown, fallbackCode: string, fallbackStatus: number): Response {
  const value = cause && typeof cause === "object" ? cause as { code?: unknown; status?: unknown; details?: unknown } : undefined;
  const code = typeof value?.code === "string" ? value.code : fallbackCode;
  const status = typeof value?.status === "number" ? value.status : fallbackStatus;
  return error(code, cause instanceof Error ? cause.message : String(cause), status, value?.details);
}

function error(code: string, message: string, status: number, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

function controlError(cause: unknown): Response {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof PrivateStoreConflictError) return error("conflict", message, 409, { outcome: "not_applied" });
  if (cause instanceof PrivateStoreDocumentNotFoundError) return error("document_not_found", message, 404);
  if (cause instanceof AnnotationLedgerError) return error(cause.code === "missing-thread" ? "thread_not_found" : "invalid_annotation", message, 400, { outcome: "not_applied" });
  const systemCode = (cause as NodeJS.ErrnoException | null)?.code;
  if (systemCode === "ENOENT") return error("path_not_found", "The requested file or directory does not exist.", 404);
  if (systemCode === "EACCES" || systemCode === "EPERM") return error("file_access_denied", "The operating system denied file access.", 403);
  if (systemCode === "EEXIST") return error("destination_exists", "The destination already exists.", 409);
  if (systemCode?.startsWith("SQLITE_") || systemCode === "ENOSPC" || systemCode === "EIO") return error("storage_unavailable", "Storage is unavailable. Inspect current state before retrying.", 503, { outcome: "outcome_unknown" });
  if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return codedError(cause, "invalid_request", 400);
  if (cause instanceof DocumentConflictError) return error("conflict", message, 409, cause.details);
  if (cause instanceof DocumentReadOnlyError) return error("ledger_invalid", message, 422, cause.ledgerError);
  if (cause instanceof DocumentNotFoundError) return error("document_not_found", message, 404);
  if (cause instanceof DocumentAccessError) return error("document_unauthorized", message, 403);
  return error("internal_error", "The operation failed unexpectedly. Check storage availability before retrying.", 500, { outcome: "outcome_unknown" });
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
  const route = new URL(request.url).pathname;
  const limit = route.includes("/import") ? INPUT_LIMITS.package : route.includes("/review/") ? 1024 * 1024 : INPUT_LIMITS.markdown + 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw Object.assign(invalidRequest("Request exceeds its byte limit."), { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw Object.assign(invalidRequest("Request exceeds its byte limit."), { status: 413 }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw invalidRequest("Invalid JSON request."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest("Invalid JSON request.");
  const body = value as Record<string, unknown>;
  validateControlInput(body, route);
  return body;
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
  if (!eventType(type)) throw invalidRequest("Invalid annotation event type.");
  if (typeof body.actor !== "string" || !body.actor.trim()) throw invalidRequest("An asserted actor is required.");
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

function hostTarget(value: unknown): HostTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}


const fallbackHtml = `<!doctype html><meta charset="utf-8"><title>Tether</title><link rel="icon" type="image/png" href="/favicon.png"><main id="app">Tether session</main>`;

/**
 * Create one loopback daemon. The document and Recents dependencies are
 * intentionally narrow so the lead can replace the filesystem fallback with
 * the extracted product services without changing this HTTP boundary.
 */
export function createDaemon(options: DaemonOptions = {}): TetherDaemon {
  const config = options.config ?? resolveConfig();
  const now = options.now ?? Date.now;
  const updates = options.updates ?? new UpdateService({ config, root: process.env.TETHER_INSTALL_ROOT, install: options.update });
  const ticketMs = options.ticketMs ?? DEFAULT_TICKET_MS;
  const leaseMs = options.leaseMs ?? Number(process.env.TETHER_LEASE_MS ?? DEFAULT_LEASE_MS);
  const startupGraceMs = options.startupGraceMs ?? Number(process.env.TETHER_STARTUP_GRACE_MS ?? DEFAULT_STARTUP_GRACE_MS);
  const idleMs = options.idleMs ?? Number(process.env.TETHER_IDLE_MS ?? DEFAULT_IDLE_MS);
  const privateStore = options.service?.store ?? new PrivateStore(join(config.configDir, "tether.sqlite"));
  const service = options.service ?? new DocumentService({ now, store: privateStore });
  const agentReads = new AgentReads(privateStore);
  const views = new ViewStore(privateStore.db);
  const trashFile = options.trashFile ?? moveToTrash;
  const pickFiles = options.pickFiles ?? (process.platform === "darwin" ? pickMarkdownFiles : undefined);
  const hostAdapter = options.hostAdapter ?? new HostGateway(config, createBrowserHost({ open: options.opener }));
  const recents = new RecentsService(options.recents ?? new RecentsRegistry({ path: config.recentsPath, now, database: privateStore.db, deletePrivateData: async (path: string) => {
    agentReads.forget(path);
    await service.deleteConversation(path);
    for (const [id, session] of sessions) if (session.grant.realPath === path) { service.close(session.grant); sessions.delete(id); }
    for (const [ticket, pending] of tickets) if (pending.grant.realPath === path) { service.close(pending.grant); tickets.delete(ticket); }
    views.forgetPath(path);
  } }), hostAdapter);
  const instanceId = crypto.randomUUID();
  const tickets = new Map<string, { grant: DocumentSession; expiresAt: number; target?: HostTarget }>();
  const recentsTickets = new Map<string, { expiresAt: number; target?: HostTarget }>();
  const sessions = new Map<string, Session>();
  const recentsSessions = new Map<string, RecentsSession>();
  const recentsStreamClosers = new Set<() => void>();
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
  let pickerOpen = false;
  const settleReady = (cause?: unknown) => {
    if (readySettled) return;
    readySettled = true;
    if (cause === undefined) resolveReady(); else rejectReady(cause);
  };

  const originFor = (port: number) => `http://${LOOPBACK}:${port}`;
  let daemon!: TetherDaemon;

  function mintTicket(grant: DocumentSession, target?: HostTarget): Ticket {
    const ticket = randomToken();
    const expiresAt = now() + ticketMs;
    tickets.set(ticket, { grant, expiresAt, target });
    return { ticket, expiresAt, url: `${daemon.origin}/launch?ticket=${encodeURIComponent(ticket)}` };
  }

  function discardTicket(ticket: string): boolean {
    const pending = tickets.get(ticket);
    if (!pending) return false;
    tickets.delete(ticket);
    service.close(pending.grant);
    return true;
  }

  function discardLaunchTicket(ticket: string): boolean {
    if (discardTicket(ticket)) return true;
    return recentsTickets.delete(ticket);
  }

  function mintRecentsTicket(target?: HostTarget): Ticket {
    const ticket = randomToken();
    const expiresAt = now() + ticketMs;
    recentsTickets.set(ticket, { expiresAt, target });
    return { ticket, expiresAt, url: `${daemon.origin}/recents/launch?ticket=${encodeURIComponent(ticket)}` };
  }

  function recentsEventStream(request: Request): Response {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      request.signal.removeEventListener("abort", cleanup);
      recentsStreamClosers.delete(cleanup);
      try { controller?.close(); } catch { /* the stream may already be cancelled or errored */ }
    };
    const send = (value: string) => {
      if (closed || !controller) return;
      try { controller.enqueue(encoder.encode(value)); }
      catch { cleanup(); }
    };
    const sendSnapshot = (snapshot: FolioSnapshot) => {
      send(`id: ${snapshot.sequence}\nevent: snapshot\ndata: ${JSON.stringify({ ...snapshot, instanceId })}\n\n`);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        unsubscribe = recents.subscribeFolio(sendSnapshot);
        recentsStreamClosers.add(cleanup);
        request.signal.addEventListener("abort", cleanup, { once: true });
        heartbeat = setInterval(() => send(": keepalive\n\n"), 20_000);
        void recents.folioSnapshot({ view: "all" }).then(sendSnapshot).catch((cause) => {
          if (!closed) {
            try { controller?.error(cause); } catch { /* already closed */ }
          }
          cleanup();
        });
        if (request.signal.aborted) cleanup();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    } });
  }

  async function folioOperation(action: string, body: Record<string, unknown>, target?: HostTarget, browser = false): Promise<unknown> {
    const paths = Array.isArray(body.paths) && body.paths.every(p => typeof p === "string") ? body.paths as string[] : typeof body.path === "string" ? [body.path] : [];
    if (paths.length > 200) throw invalidRequest("Select no more than 200 documents at once.");
    if (action === "list") return { ...await recents.folioSnapshot(body as ListFolioOptions), instanceId };
    if (action === "sync") return recents.retryHostSync(target);
    if (action === "add") { if (!paths.length) throw invalidRequest("At least one Markdown path is required."); return recents.recordMany(paths, target); }
    if (browser && paths.length) {
      const known = new Set((await recents.folioSnapshot({ view: "all" })).files.map(file => file.path));
      if (paths.some(path => !known.has(resolve(path)))) throw new DocumentAccessError("The selection is not in Folio.");
    }
    if (action === "archive" || action === "clear-unpinned") {
      if ((await recents.getRetention()).mode === "immediate" && body.confirmed !== true) throw Object.assign(new Error("Confirm deleting the selected archived data."), { code: "confirmation_required" });
      return action === "archive" ? recents.archive(paths, target) : recents.clearUnpinned(target);
    }
    if (action === "restore") return recents.restore(paths, target);
    if (action === "pin" || action === "unpin") { await recents.setPinned(paths, action === "pin" && body.pinned !== false); return { updated: true }; }
    if (action === "settings") {
      if (body.retention === undefined) return { retention: await recents.getRetention() };
      if (body.confirmed !== true) throw Object.assign(new Error("Confirm the archive retention change."), { code: "confirmation_required" });
      return recents.setRetention(body.retention as FolioRetention, target);
    }
    if (action === "delete-conversation" || action === "start-fresh" || action === "delete") {
      if (body.confirmed !== true) throw Object.assign(new Error("Confirm deleting the selected conversations."), { code: "confirmation_required" });
      if (action === "delete") return recents.delete(paths, target);
      for (const path of paths) { agentReads.forget(resolve(path)); privateStore.deleteConversation(resolve(path)); }
      await recents.refresh();
      return { cleared: paths };
    }
    if (action === "locate") {
      let destination = typeof body.target === "string" ? body.target : undefined;
      if (!destination && browser && pickFiles) destination = (await pickFiles())[0];
      if (!paths[0]) throw invalidRequest("A source path is required.");
      if (!destination) return { cancelled: true };
      const entry = await recents.locate(paths[0], destination);
      const parent = await stat(dirname(entry.path));
      privateStore.db.query("UPDATE reader_views SET path=?,parent_dev=?,parent_ino=? WHERE path=?").run(entry.path, parent.dev, parent.ino, resolve(paths[0]));
      return entry;
    }
    if (action === "export") {
      const grants: DocumentSession[] = [];
      try { for (const path of paths) grants.push(await service.open(path)); return await service.exportReviews(grants); }
      finally { for (const grant of grants) service.close(grant); }
    }
    if (action === "import") {
      const directory = browser ? await chooseImportDirectory() : typeof body.directory === "string" ? body.directory : null;
      if (!directory) return { cancelled: true };
      const result = await service.importReviewsResult(body.package, directory);
      const livePaths: string[] = [];
      for (const path of result.paths) if (privateStore.documentForPath(path) && await stat(path).then(info => info.isFile()).catch(() => false)) livePaths.push(path);
      try {
        const registration = livePaths.length ? await recents.recordMany(livePaths, target) : undefined;
        return { ...result, ...(registration ? { registration } : {}) };
      } catch (cause) {
        return { ...result, registration: { outcome: "outcome_unknown", code: "folio_registration_failed", message: cause instanceof Error ? cause.message : String(cause), retry: "Retry the same import to register committed files." } };
      }
    }
    if (action === "service") {
      if (body.action !== "restart" && body.action !== "quit") throw invalidRequest("Unknown service action.");
      if (body.action === "restart" && !options.restart) throw invalidRequest("Restart is unavailable in this embedded test service.");
      if (body.action === "restart") await prepareCmuxBridgeRestart(config, instanceId);
      setTimeout(() => { void (body.action === "restart" ? options.restart!() : daemon.stop()); }, 250);
      return { restarting: body.action === "restart", quitting: body.action === "quit" };
    }
    throw invalidRequest("Unknown Folio action.");
  }

  function sessionFrom(request: Request, pathname: string): Session | Response {
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return error("invalid_session", "The browser session route is invalid.", 404);
    let id: string;
    try { id = decodeURIComponent(match[1]); } catch { return error("invalid_session", "The browser session route is invalid.", 404); }
    const session = sessions.get(id);
    if (!session) return error("session_expired", "The browser session has expired.", 401);
    if (!verifiesCookie(cookieValue(request, "tether_session"), session.verifier ?? cookieVerifier(session.cookie))) return error("unauthorized", "A scoped browser session cookie is required.", 401);
    session.lastSeen = now();
    return session;
  }

  let preferenceWrites: Promise<unknown> = Promise.resolve();

  async function preferences(): Promise<AppPreferences> {
    try { return preferencesFrom(JSON.parse(await readFile(config.preferencesPath, "utf8"))); } catch { return preferencesFrom(null); }
  }

  async function withControlDocument<T>(body: Record<string, unknown>, operation: (grant: DocumentSession) => Promise<T>): Promise<T> {
    if (typeof body.path !== "string" || !body.path.trim()) throw invalidRequest("A Markdown path is required.");
    const grant = await service.open(body.path);
    try { return await operation(grant); }
    finally { service.close(grant); }
  }

  function mutationSummary(document: DocumentSnapshot): Record<string, unknown> {
    return {
      path: document.path,
      bodyRevision: document.bodyRevision,
      ledgerRevision: document.ledgerRevision,
      appliedSequence: (document as DocumentSnapshot & { mutation?: { appliedSequence?: number } }).mutation?.appliedSequence,
      mutation: (document as DocumentSnapshot & { mutation?: unknown }).mutation,
      unresolvedCount: document.annotations.unresolvedCount,
    };
  }

  async function browserAnnotation(input: AppendEventInput): Promise<DocumentSnapshot> {
    const result = await service.appendEvent(input);
    await recents.refresh();
    return result;
  }

  async function sessionApi(request: Request, session: Session, path: string): Promise<Response> {
    const apiPath = path.replace(/^\/s\/[^/]+\/api/, "") || "/";
    const stateChanging = request.method !== "GET" && request.method !== "HEAD";
    if (stateChanging && !sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
    try {
      if (apiPath === "/bootstrap" && request.method === "GET") {
        const document = await service.read(session.grant);
        return json({ protocol: PROTOCOL_VERSION, sessionId: session.id, draft: views.draft(session.id), scroll: views.position(session.id), document, capabilities: hostAdapter.capabilities(session.target), preferences: await preferences(), actor: options.actor ?? "assistant" });
      }
      if (apiPath === "/position" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.scroll !== "number" || !Number.isFinite(body.scroll) || body.scroll < 0) throw invalidRequest("Invalid reader position.");
        views.savePosition(session.id, body.scroll);
        return json({ saved: true });
      }
      if (apiPath === "/draft" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.body !== "string" || body.body.length > 8_000_000 || typeof body.baseRevision !== "string") return error("invalid_request", "Invalid draft.", 400);
        views.saveDraft(session.id, { body: body.body, baseRevision: body.baseRevision, scroll: typeof body.scroll === "number" && Number.isFinite(body.scroll) ? Math.max(0, body.scroll) : 0, updatedAt: now() });
        return json({ saved: true });
      }
      if (apiPath === "/draft" && request.method === "DELETE") { views.clearDraft(session.id); return json({ cleared: true }); }
      if (apiPath === "/export" && request.method === "POST") return json(await service.exportReviews([session.grant]));
      if (apiPath === "/file" && request.method === "GET") return json(await service.read(session.grant));
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
          if (!textBody(body) || typeof body.threadId !== "string") throw invalidRequest("A reply needs threadId and body.");
          event = selectEvent({ ...body, type: "reply", body: textBody(body) }, "reply");
        } else if (action === "edit") {
          if (!textBody(body) || typeof body.threadId !== "string" || typeof body.targetId !== "string") throw invalidRequest("An edit needs threadId, targetId, and body.");
          event = selectEvent({ ...body, type: "edit", body: textBody(body) }, "edit");
        } else if (action === "delete") {
          if (typeof body.threadId !== "string" || typeof body.targetId !== "string") throw invalidRequest("A delete event needs threadId and targetId.");
          event = selectEvent({ ...body, type: "delete" }, "delete");
        } else if (action === "acknowledge") {
          if (typeof body.cursor !== "string" || !body.cursor) throw invalidRequest("An acknowledgement needs the cursor returned by pending.");
          event = selectEvent({ ...body, type: "ack" }, "ack");
        } else {
          if (typeof body.threadId !== "string") throw invalidRequest(`A ${action} event needs threadId.`);
          event = selectEvent({ ...body, type: action }, action);
        }
        return json(await browserAnnotation({ session: session.grant, event, cursor: typeof body.cursor === "string" ? body.cursor : undefined, operationId: typeof body.operationId === "string" ? body.operationId : undefined, expectedBodyRevision: action === "acknowledge" ? body.bodyRevision as string : expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/annotations" && request.method === "POST") {
        const body = await requestJson(request);
        return json(await browserAnnotation({ session: session.grant, event: selectEvent(body), operationId: typeof body.operationId === "string" ? body.operationId : undefined, expectedBodyRevision: expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/lease" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId !== "string" || !body.clientId) return error("invalid_client", "A lease clientId is required.", 400);
        const leaseId = body.clientId;
        session.leases.set(leaseId, now() + leaseMs);
        emptySince = 0;
        const read = await service.read(session.grant);
        return json({ path: read.path, bodyRevision: read.bodyRevision, ledgerRevision: read.ledgerRevision, revision: read.bodyRevision });
      }
      if (apiPath === "/release" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId === "string") session.leases.delete(body.clientId);
        // A pagehide beacon also fires during reload, browser suspension, and
        // host-managed webview transitions. It releases presence only; the
        // document-scoped authorization remains valid until explicit daemon
        // shutdown.
        session.lastSeen = now();
        return json({ ok: true });
      }
      if (apiPath === "/open" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.target !== "string" || !body.target.trim()) throw invalidRequest("A wikilink target is required.");
        if (body.format !== undefined && body.format !== "markdown" && body.format !== "wikilink") throw invalidRequest("Invalid link format.");
        const path = await service.resolveWikilink(session.grant.path, body.target, body.format);
        const sourceUrl = `${daemon.origin}/s/${session.id}/`;
        if (![".md", ".markdown"].includes(extname(path).toLowerCase())) {
          if (session.target?.host === "cmux") {
            if (!hostAdapter.openLocalFile) throw invalidRequest("Native local-file opening is unavailable in this host.");
            await hostAdapter.openLocalFile({ path, sourceUrl, target: session.target });
            return json({ path, resolvedPath: path, opened: true });
          }
          if (!hostAdapter.capabilities(session.target).revealFile || !hostAdapter.revealFile) throw invalidRequest("Revealing local files is unavailable in this host.");
          await hostAdapter.revealFile(path);
          return json({ path, resolvedPath: path, opened: false, revealed: true });
        }
        const grant = await service.open(path);
        const ticket = mintTicket(grant, session.target);
        try { await hostAdapter.openView({ url: ticket.url, kind: "document", focus: true, target: session.target,
          ...(session.target?.host === "cmux" ? { targetPolicy: "source-pane" as const, sourceUrl } : {}),
        }); }
        catch (cause) { discardTicket(ticket.ticket); throw cause; }
        return json({ path: grant.path, resolvedPath: grant.realPath, opened: true });
      }
      if (apiPath === "/preferences" && request.method === "PUT") {
        const body = await requestJson(request);
        const operation = preferenceWrites.then(async () => {
          const value = updatePreferences(await preferences(), body);
          const { mkdir, writeFile, rename } = await import("node:fs/promises");
          await mkdir(dirname(config.preferencesPath), { recursive: true, mode: 0o700 });
          const temp = `${config.preferencesPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
          await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
          await rename(temp, config.preferencesPath);
          return value;
        });
        preferenceWrites = operation.catch(() => {});
        const value = await operation;
        return json(value);
      }
      return error("not_found", "API endpoint not found.", 404);
    } catch (cause) {
      const status = cause instanceof DocumentConflictError ? 409 : cause instanceof DocumentReadOnlyError ? 422 : 400;
      if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return codedError(cause, "invalid_request", status);
      return error(status === 409 ? "conflict" : status === 422 ? "ledger_invalid" : "invalid_request", (cause as Error).message || "Request failed.", status);
    }
  }

  async function requestHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId });
    if (pathname === "/favicon.png" && request.method === "GET") {
      return new Response(Bun.file(resolve(runtimeRoot(), process.env.TETHER_INSTALL_ROOT ? "dist/favicon.png" : "src/web/favicon.png")), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
      });
    }
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
      const session: Session = { id, grant: pending.grant, cookie: randomToken(), createdAt, lastSeen: createdAt, leases: new Map(), ...(pending.target ? { target: pending.target } : {}) };
      sessions.set(id, session);
      views.put({ id, kind: "document", path: session.grant.realPath, verifier: cookieVerifier(session.cookie), createdAt, target: session.target });
      try { await recents.record(pending.grant.realPath, pending.target); }
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
    if (pathname === "/recents/launch" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket");
      const pending = ticket ? recentsTickets.get(ticket) : undefined;
      if (!ticket || !pending) return error("ticket_invalid", "The Recents launch ticket is invalid or already used.", 401);
      recentsTickets.delete(ticket);
      if (pending.expiresAt <= now()) return error("ticket_expired", "The Recents launch ticket has expired.", 401);
      const id = randomToken();
      const createdAt = now();
      const session: RecentsSession = { id, cookie: randomToken(), createdAt, lastSeen: createdAt, leaseUntil: createdAt + leaseMs, ...(pending.target ? { target: pending.target } : {}) };
      recentsSessions.set(id, session);
      views.put({ id, kind: "folio", path: null, verifier: cookieVerifier(session.cookie), createdAt, target: session.target });
      const root = `/r/${encodeURIComponent(id)}/`;
      return new Response(null, { status: 302, headers: {
        location: `${root}?instance=${encodeURIComponent(daemon.instanceId)}`,
        "set-cookie": `tether_recents=${session.cookie}; Path=${root}; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store", "referrer-policy": "no-referrer",
      } });
    }
    if (pathname.startsWith("/r/")) {
      const match = /^\/r\/([^/]+)\/(.*)$/.exec(pathname);
      const session = match ? recentsSessions.get(decodeURIComponent(match[1])) : undefined;
      if (!session) return error("session_expired", "The Recents session has expired.", 401);
      if (!verifiesCookie(cookieValue(request, "tether_recents"), session.verifier ?? cookieVerifier(session.cookie))) return error("unauthorized", "A scoped Recents cookie is required.", 401);
      session.lastSeen = now();
      const suffix = `/${match![2]}`;
      if (request.method === "GET" && suffix === "/") {
        const prefs = await preferences();
        return new Response(folioHtml({ pickerAvailable: Boolean(pickFiles), theme: prefs.theme, design: prefs.customThemes?.find(theme => theme.id === prefs.theme) }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "GET" && suffix === "/api/files") return json(await recents.files());
      if (request.method === "GET" && suffix === "/api/updates") return json(await updates.status(), { headers: { "cache-control": "no-store" } });
      if (request.method === "POST" && ["/api/updates/install", "/api/updates/dismiss"].includes(suffix)) {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = await requestJson(request);
          if (suffix.endsWith("/install")) await updates.install(body.tag);
          else await updates.dismiss(body.tag);
          return json({ ok: true });
        } catch (cause) { return codedError(cause, "update_failed", 409); }
      }
      if (request.method === "GET" && suffix === "/api/snapshot") return json({ ...await recents.folioSnapshot({ view: "all" }), instanceId });
      if (request.method === "GET" && suffix === "/api/events") return recentsEventStream(request);
      if (request.method === "POST" && suffix === "/api/filters") {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = await requestJson(request);
          if (!["save", "set-active", "delete"].includes(String(body.action)) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000 || (body.action === "set-active" && typeof body.active !== "boolean")) {
            throw invalidRequest("Provide a filter of 1–1000 characters and a valid filter action.");
          }
          return json({ ...await recents.changeFilter(body.action as "save" | "set-active" | "delete", body.text, body.active as boolean | undefined), instanceId });
        } catch (cause) { return controlError(cause); }
      }
      if (request.method === "POST" && suffix === "/api/lease") { session.leaseUntil = now() + leaseMs; return json({ ok: true }); }
      if (request.method === "POST" && suffix === "/api/pick") {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        if (!pickFiles) return error("picker_unavailable", "The native Markdown picker is unavailable on this platform.", 501);
        if (pickerOpen) return error("picker_busy", "The native Markdown picker is already open.", 409);
        pickerOpen = true;
        try {
          const paths = await pickFiles();
          if (!paths.length) return json({ cancelled: true, added: 0 });
          const result = await recents.recordMany(paths, session.target);
          return json({ cancelled: false, added: result.added.length });
        } catch (cause) { return codedError(cause, "pick_failed", 400); }
        finally { pickerOpen = false; }
      }
      if (request.method === "POST" && (suffix === "/api/open" || suffix === "/api/welcome")) {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = suffix === "/api/welcome" ? { path: await seedWelcome(config) } : await requestJson(request);
          if (typeof body.path !== "string") throw invalidRequest("A recent Markdown path is required.");
          if (suffix === "/api/welcome") await recents.record(body.path, session.target);
          const allowed = await recents.paths();
          const canonical = await realpath(body.path);
          if (!allowed.includes(canonical)) return error("document_unauthorized", "The path is not in Tether Folio.", 403);
          const grant = await service.open(canonical);
          const launch = mintTicket(grant, session.target);
          try {
            await hostAdapter.openView({
              url: launch.url,
              kind: "document",
              focus: true,
              allowFocusedFallback: true,
              ...(session.target?.host === "cmux" ? { targetPolicy: "focused-workspace" as const } : {}),
              target: session.target,
            });
          }
          catch (cause) { discardTicket(launch.ticket); throw cause; }
          return json({ opened: true, path: grant.path });
        } catch (cause) { return codedError(cause, "open_failed", 400); }
      }
      if (request.method === "POST" && ["/api/action", "/api/batch", "/api/settings", "/api/import", "/api/clear-unpinned", "/api/service"].includes(suffix)) {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = await requestJson(request);
          const action = suffix === "/api/action" || suffix === "/api/batch" ? String(body.action) : suffix.slice(5);
          if (["reveal", "default", "trash"].includes(action)) {
            const path = typeof body.path === "string" ? await realpath(body.path) : "";
            if (!(await recents.paths()).includes(path)) throw new DocumentAccessError();
            if (action === "reveal") { if (!hostAdapter.revealFile) throw invalidRequest("Reveal is unavailable."); await hostAdapter.revealFile(path); }
            if (action === "default") await hostAdapter.openExternal(path);
            if (action === "trash") { if (body.confirmed !== true) throw invalidRequest("Confirm moving the file to Trash."); await trashFile(path); await recents.remove(path, session.target); }
            return json({ action, path });
          }
          return json(await folioOperation(action === "remove" ? "archive" : action, body, session.target, true));
        } catch (cause) { return controlError(cause); }
      }
      return error("not_found", "Recents resource not found.", 404);
    }
    if (pathname.startsWith("/control/")) {
      const expected = await readControlToken(config);
      if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return error("forbidden", "Control authorization is required.", 403);
      try {
        if (pathname === "/control/launch" && request.method === "POST") {
          const body = await requestJson(request);
          const grant = await service.open(typeof body.path === "string" ? body.path : "");
          const target = hostTarget(body.target);
          const ticket = mintTicket(grant, target);
          return json({ ...ticket, path: grant.path });
        }
        if (pathname.startsWith("/control/folio/") && request.method === "POST") {
          const body = await requestJson(request);
          return json(await folioOperation(pathname.slice("/control/folio/".length), body, hostTarget(body.target)));
        }
        if (pathname === "/control/recents/launch" && request.method === "POST") {
          const body = await requestJson(request);
          return json(mintRecentsTicket(hostTarget(body.target)));
        }
        if (pathname === "/control/recents/add" && request.method === "POST") {
          try {
            const body = await requestJson(request);
            if (typeof body.path !== "string" || !body.path.trim()) throw invalidRequest("A recent Markdown path is required.");
            const result = await recents.record(body.path, hostTarget(body.target));
            return json({ path: result.entry.path, recentCount: result.entries.length, hostSynchronized: result.hostSynchronized });
          } catch (cause) {
            return error("command_failed", cause instanceof Error ? cause.message : String(cause), 500);
          }
        }
        if (pathname === "/control/cancel" && request.method === "POST") {
          const body = await requestJson(request);
          if (typeof body.ticket !== "string" || !body.ticket) return error("invalid_request", "A launch ticket is required.", 400);
          return json({ cancelled: discardLaunchTicket(body.ticket) });
        }
        if (request.method === "POST" && (pathname.startsWith("/control/document/") || pathname.startsWith("/control/review/"))) {
          const body = await requestJson(request);
          if (pathname === "/control/document/move") {
            if (typeof body.path !== "string" || typeof body.target !== "string") throw invalidRequest("Move requires source and destination paths.");
            const result = await service.move(body.path, body.target);
            await recents.refresh();
            return json(result);
          }
          const result = await withControlDocument(body, async (grant) => {
            const actionName = pathname.split("/").at(-1)!;
            if (["outline", "context", "diff", "pending", "threads", "thread", "event", "quote-candidates", "operation"].includes(actionName)) {
              const source = await service.exportExact(grant);
              if (actionName === "outline") return agentReads.outline(grant.path, source, body);
              if (actionName === "context") {
                if (typeof body.threadId !== "string") throw invalidRequest("Context requires threadId.");
                return agentReads.context(grant.path, source, body.threadId, body);
              }
              if (actionName === "diff") {
                if (typeof body.fromRevision !== "string") throw invalidRequest("Diff requires fromRevision.");
                return agentReads.diff(grant.path, source, body.fromRevision, body);
              }
              if (actionName === "pending") {
                if (typeof body.actor !== "string") throw invalidRequest("Pending requires actor.");
                return agentReads.pending(grant.path, source, { ...body, actor: body.actor, consumer: typeof body.consumer === "string" ? body.consumer : body.actor });
              }
              if (actionName === "threads") return agentReads.threads(grant.path, source, body);
              if (actionName === "thread") {
                if (typeof body.threadId !== "string") throw invalidRequest("A thread ID is required.");
                return agentReads.thread(grant.path, source, body.threadId, body);
              }
              if (actionName === "event") {
                if (typeof body.eventId !== "string") throw invalidRequest("An event ID is required.");
                return agentReads.event(grant.path, body.eventId, body);
              }
              if (actionName === "operation") {
                if (typeof body.operationId !== "string") throw invalidRequest("An operation ID is required.");
                return privateStore.lookupMutation(grant.path, body.operationId);
              }
              if (typeof body.quote !== "string") throw invalidRequest("A quote is required.");
              return quoteCandidates(source, body.quote, body);
            }
            if (pathname === "/control/document/read") {
              const doc = await service.read(grant);
              return { path: doc.path, body: doc.body, bodyRevision: doc.bodyRevision, conversationRevision: doc.ledgerRevision };
            }
            if (pathname === "/control/document/save") {
              if (typeof body.body !== "string" || typeof body.expectedBodyRevision !== "string") throw invalidRequest("Document save requires body and expectedBodyRevision.");
              return mutationSummary(await service.saveBody({ session: grant, body: body.body, expectedBodyRevision: body.expectedBodyRevision }));
            }
            if (pathname === "/control/review/comment") {
              if (typeof body.actor !== "string" || !textBody(body) || typeof body.quote !== "string") throw invalidRequest("A comment needs actor, body and quote.");
              const requestFingerprint = { type: "comment", actor: body.actor, body: textBody(body), quote: body.quote, ...(body.candidateId ? { candidateId: body.candidateId } : {}), ...(body.expectedBodyRevision ? { expectedBodyRevision: body.expectedBodyRevision } : {}) };
              if (typeof body.operationId === "string") {
                const replay = await service.mutationReceipt(grant, body.operationId, requestFingerprint);
                if (replay) return mutationSummary(replay);
              }
              const doc = await service.read(grant);
              if ((body.candidateId || body.expectedBodyRevision) && body.expectedBodyRevision !== doc.bodyRevision) throw new DocumentConflictError("The quote candidate requires the current body revision.", { currentBodyRevision: doc.bodyRevision });
              const anchor = anchorForQuote(doc.body, body.quote, doc.bodyRevision, typeof body.candidateId === "string" ? body.candidateId : undefined);
              return mutationSummary(await service.appendComment({ session: grant, actor: body.actor, body: textBody(body), requestFingerprint, anchor, expectedBodyRevision: doc.bodyRevision, operationId: typeof body.operationId === "string" ? body.operationId : undefined }));
            }
            const action = /^\/control\/review\/(reply|resolve|reopen|edit|delete|acknowledge)$/.exec(pathname)?.[1];
            if (!action) throw invalidRequest("Control endpoint not found.");
            if (typeof body.actor !== "string" || !body.actor.trim()) throw invalidRequest(`Review ${action} requires actor.`);
            let event: AnnotationEventInput;
            if (action === "edit" || action === "delete") {
              if (typeof body.threadId !== "string" || typeof body.targetId !== "string" || (action === "edit" && !textBody(body))) throw invalidRequest("Edit/delete requires threadId, targetId, and edit text.");
              event = selectEvent({ ...body, type: action, ...(action === "edit" ? { body: textBody(body) } : {}) }, action);
            } else if (action === "reply") {
              if (typeof body.threadId !== "string" || !textBody(body)) throw invalidRequest("A reply needs threadId and body.");
              event = selectEvent({ ...body, type: "reply", body: textBody(body) }, "reply");
            } else if (action === "acknowledge") {
              if (typeof body.cursor !== "string" || !body.cursor) throw invalidRequest("An acknowledgement needs the cursor returned by pending.");
              event = selectEvent({ ...body, type: "ack" }, "ack");
            } else {
              if (typeof body.threadId !== "string" || !body.threadId) throw invalidRequest(`A ${action} event needs threadId.`);
              event = selectEvent({ ...body, type: action }, action);
            }
            return mutationSummary(await service.appendEvent({
              session: grant,
              event,
              cursor: typeof body.cursor === "string" ? body.cursor : undefined,
              consumer: typeof body.consumer === "string" ? body.consumer : undefined,
              operationId: typeof body.operationId === "string" ? body.operationId : undefined,
              expectedThreadSequence: typeof body.expectedThreadSequence === "number" ? body.expectedThreadSequence : undefined,
              expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined,
            }));
          });
          if (pathname.startsWith("/control/review/") && !["pending", "thread", "threads", "event", "quote-candidates", "operation"].includes(pathname.split("/").at(-1)!)) await recents.refresh();
          return json(result);
        }
        if (pathname === "/control/status" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId, origin: daemon.origin, pid: process.pid, sessions: sessions.size });
        if (pathname === "/control/stop" && request.method === "POST") { setTimeout(() => { void daemon.stop(); }, 50); return json({ stopping: true }); }
      } catch (cause) { return controlError(cause); }
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

  const requests = new Set<Promise<Response>>();
  const bunServer = Bun.serve({ hostname: LOOPBACK, port: options.port ?? 0, fetch: (request: Request) => {
    if (stopped) return error("service_stopping", "Tether is restarting.", 503);
    const pending = requestHandler(request);
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
    return pending;
  } });
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
      for (const close of [...recentsStreamClosers]) close();
      await Promise.allSettled([...requests]);
      for (const session of sessions.values()) service.close(session.grant);
      sessions.clear();
      for (const pending of tickets.values()) service.close(pending.grant);
      tickets.clear();
      recentsTickets.clear();
      recentsSessions.clear();
      for (const close of [...recentsStreamClosers]) close();
      await Bun.sleep(0); // Flush closed event streams before dropping keep-alive sockets.
      await bunServer.stop(true);
      if (!options.service) privateStore.close();
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
      await service.recoverMoves();
      if (stopped) return;
      if (options.persistentViews) {
        for (const view of views.list()) {
          if (view.kind === "folio") recentsSessions.set(view.id, { id: view.id, cookie: "", verifier: view.verifier, createdAt: view.createdAt, lastSeen: now(), leaseUntil: now() + leaseMs, target: view.target });
          else if (view.path) {
            try {
              if (await realpath(view.path) !== view.path) throw new DocumentAccessError();
              const parent = await stat(dirname(view.path));
              if (view.parent && (parent.dev !== view.parent.dev || parent.ino !== view.parent.ino)) throw new DocumentAccessError();
              const grant = await service.open(view.path);
              if (!view.parent) views.put({ ...view, parent: { dev: parent.dev, ino: parent.ino } });
              sessions.set(view.id, { id: view.id, grant, cookie: "", verifier: view.verifier, createdAt: view.createdAt, lastSeen: now(), leases: new Map(), target: view.target });
            }
            catch { /* Missing files remain available in Folio for Locate file. */ }
          }
        }
      }
      await ensureControlToken(config);
      if (stopped) return;
      await writeDiscovery(config, { protocol: PROTOCOL_VERSION, instanceId, pid: process.pid, origin: daemon.origin, startedAt: new Date(startedAt).toISOString() });
      if (stopped) { await removeDiscovery(config, instanceId); return; }
      await recents.expire();
      let lastExpiry = now();
      timer = setInterval(() => {
        const current = now();
        if (current - lastExpiry >= 60_000) { lastExpiry = current; void recents.expire().catch(() => {}); }
        for (const session of [...sessions.values()]) {
          for (const [lease, expiry] of session.leases) if (expiry <= current) session.leases.delete(lease);
        }
        for (const [ticket, pending] of tickets) {
          if (pending.expiresAt <= current) {
            tickets.delete(ticket);
            service.close(pending.grant);
          }
        }
        for (const [ticket, pending] of recentsTickets) if (pending.expiresAt <= current) recentsTickets.delete(ticket);
        const active = sessions.size > 0 || recentsSessions.size > 0 || tickets.size > 0 || recentsTickets.size > 0;
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
  const config = options.config ?? resolveConfig();
  await prepareConfig(config);
  const listenerPath = join(config.runtimeDir, "listener.json");
  let port = options.port;
  if (port === undefined) {
    try {
      const saved = JSON.parse(readFileSync(listenerPath, "utf8"));
      if (Number.isSafeInteger(saved.port) && saved.port > 0 && saved.port < 65536) port = saved.port;
    } catch { /* First launch allocates a port and remembers it. */ }
  }
  let configured = { ...options, config, port, persistentViews: options.persistentViews ?? true };
  if (!configured.web) {
    const { createWebBundleResponder } = await import("../web/bundle");
    const responder = await createWebBundleResponder();
    configured = { ...configured, web: (request: Request) => responder(request) };
  }
  const daemon = createDaemon(configured);
  await daemon.ready;
  writeFileSync(listenerPath, JSON.stringify({ port: daemon.port }), { mode: 0o600 });
  return daemon;
}

export async function createLaunchTicket(daemon: TetherDaemon, path: string): Promise<Ticket> {
  return daemon.mintTicket(await daemon.service.open(path));
}
