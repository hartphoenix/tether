import { readDiscovery, acquireStartupLock, prepareConfig, removeStaleRuntime, resolveConfig, type TetherConfig } from "./config";
import { PROTOCOL_VERSION, SERVICE_ID, type DiscoveryRecord } from "../shared/contracts";
import { runtimeEntry } from "../runtime-paths";
import type { HostTarget } from "../hosts/host-adapter";

const LOOPBACK = "127.0.0.1";
const WAIT_MS = 100;
const WAIT_ATTEMPTS = 100;

export type DaemonStatus = {
  running: boolean;
  protocol?: number;
  service?: string;
  instanceId?: string;
  pid?: number;
  origin?: string;
  startedAt?: string;
  sessions?: number;
};

export class ControlRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ControlRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type EnsureDaemonOptions = {
  config?: TetherConfig;
  /** Used by tests and alternate launchers; defaults to this source checkout's daemon entrypoint. */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string[], env: NodeJS.ProcessEnv) => Promise<void> | void;
  now?: () => number;
  waitAttempts?: number;
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function health(discovery: DiscoveryRecord): Promise<boolean> {
  try {
    const response = await fetch(`${discovery.origin}/health`, { signal: AbortSignal.timeout(300) });
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    return value.service === SERVICE_ID && value.protocol === PROTOCOL_VERSION && value.instanceId === discovery.instanceId;
  } catch { return false; }
}

export async function discoverDaemon(config = resolveConfig()): Promise<DiscoveryRecord | null> {
  const value = await readDiscovery(config);
  if (!value || !alive(value.pid) || !(await health(value))) return null;
  return value;
}

async function waitForDiscovery(config: TetherConfig, attempts: number): Promise<DiscoveryRecord | null> {
  for (let index = 0; index < attempts; index += 1) {
    const value = await discoverDaemon(config);
    if (value) return value;
    await Bun.sleep(WAIT_MS);
  }
  return null;
}

function defaultCommand(): string[] {
  return [process.execPath, runtimeEntry("daemon"), "serve"];
}

/** Start or reuse the one daemon for this profile. The lock covers all state decisions. */
export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DiscoveryRecord> {
  const config = options.config ?? resolveConfig();
  await prepareConfig(config);
  const existing = await discoverDaemon(config);
  if (existing) return existing;

  let lock: Awaited<ReturnType<typeof acquireStartupLock>> | null = null;
  try {
    lock = await acquireStartupLock(config);
  } catch {
    // A peer owns startup. Wait for it to publish and validate discovery; do
    // not launch a second process merely because its port is not ready yet.
    const converged = await waitForDiscovery(config, options.waitAttempts ?? WAIT_ATTEMPTS);
    if (converged) return converged;
    throw new Error("Another Tether daemon appears to be starting but did not become healthy.");
  }

  try {
    const winner = await discoverDaemon(config);
    if (winner) return winner;
    const command = options.command ?? defaultCommand();
    const inherited = options.env ?? process.env;
    // Never pass host/browser credentials or the caller's arbitrary secrets to
    // the detached daemon. The daemon receives only launch/runtime essentials.
    const env: NodeJS.ProcessEnv = {
      PATH: inherited.PATH,
      TMPDIR: inherited.TMPDIR,
      LANG: inherited.LANG,
      LC_ALL: inherited.LC_ALL,
      TETHER_PROFILE: config.profile,
      TETHER_RUNTIME_DIR: config.runtimeDir,
      TETHER_CONFIG_DIR: config.configDir,
      TETHER_INSTALL_ROOT: inherited.TETHER_INSTALL_ROOT,
    };
    if (options.spawn) await options.spawn(command, env);
    else {
      const child = Bun.spawn(command, { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
    }
    const started = await waitForDiscovery(config, options.waitAttempts ?? WAIT_ATTEMPTS * 2);
    if (!started) throw new Error("Tether daemon did not become healthy.");
    return started;
  } finally {
    await lock.release();
  }
}

export async function statusDaemon(config = resolveConfig()): Promise<DaemonStatus> {
  const discovery = await discoverDaemon(config);
  if (!discovery) return { running: false };
  try {
    const response = await fetch(`${discovery.origin}/control/status`, { headers: { authorization: `Bearer ${await (await import("./config")).readControlToken(config) ?? ""}` }, signal: AbortSignal.timeout(500) });
    const payload = await response.json() as Record<string, unknown>;
    return { running: true, protocol: discovery.protocol, service: SERVICE_ID, instanceId: discovery.instanceId, pid: discovery.pid, origin: discovery.origin, startedAt: discovery.startedAt, sessions: typeof payload.sessions === "number" ? payload.sessions : undefined };
  } catch {
    return { running: true, protocol: discovery.protocol, service: SERVICE_ID, instanceId: discovery.instanceId, pid: discovery.pid, origin: discovery.origin, startedAt: discovery.startedAt };
  }
}

export async function stopDaemon(config = resolveConfig()): Promise<{ running: boolean; stopping: boolean }> {
  const discovery = await discoverDaemon(config);
  if (!discovery) {
    await removeStaleRuntime(config);
    return { running: false, stopping: false };
  }
  const { readControlToken } = await import("./config");
  const token = await readControlToken(config);
  if (!token) throw new Error("Daemon control credential is unavailable.");
  const response = await fetch(`${discovery.origin}/control/stop`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error((await response.text()) || "Unable to stop the daemon.");
  return { running: true, stopping: true };
}

/** Validate successful control payloads before callers can mistake malformed data for work. */
export function validateControlResponse(pathname: string, payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if ("error" in value) return false;
  if (pathname.endsWith("/launch")) return typeof value.url === "string" && typeof value.expiresAt === "number" && (pathname !== "/control/launch" || typeof value.path === "string");
  if (pathname === "/control/document/read") return typeof value.path === "string" && typeof value.body === "string" && typeof value.bodyRevision === "string";
  if (pathname === "/control/review/pending") return Array.isArray(value.events) && typeof value.cursor === "string" && typeof value.maxSequence === "number";
  if (pathname === "/control/review/thread") return (typeof value.path === "string" || typeof value.documentId === "string") && value.thread !== null && typeof value.thread === "object";
  if (pathname === "/control/review/threads") return Array.isArray(value.threads);
  if (pathname === "/control/folio/list") return Array.isArray(value.files);
  if (pathname === "/control/folio/export") return value.format === "tether-review" && value.version === 1 && Array.isArray(value.documents);
  if (/^\/control\/review\/(comment|reply|edit|delete|resolve|reopen|acknowledge)$/.test(pathname)) {
    const mutation = value.mutation as Record<string, unknown> | undefined;
    return Boolean(mutation && typeof mutation.operationId === "string" && typeof mutation.sequence === "number" && typeof mutation.replayed === "boolean");
  }
  if (pathname === "/control/document/outline") return typeof value.bodyRevision === "string" && Array.isArray(value.headings);
  if (pathname === "/control/document/context") return typeof value.bodyRevision === "string" && typeof value.anchorStatus === "string" && typeof value.text === "string";
  if (pathname === "/control/document/diff") return typeof value.bodyRevision === "string" && typeof value.status === "string";
  if (pathname === "/control/document/save") return typeof value.bodyRevision === "string";
  if (pathname === "/control/document/move") return typeof value.path === "string" && typeof value.previousPath === "string" && typeof value.documentId === "string" && value.outcome === "applied";
  if (pathname === "/control/review/quote-candidates") return typeof value.bodyRevision === "string" && typeof value.omitted === "boolean" && Array.isArray(value.candidates) && value.candidates.every(item => item && typeof item === "object" && typeof item.candidateId === "string" && typeof item.before === "string" && typeof item.after === "string");
  if (pathname === "/control/review/operation") return typeof value.operationId === "string" && (value.outcome === "applied" || value.outcome === "outcome_unknown") && (value.outcome !== "applied" || value.receipt !== null && typeof value.receipt === "object");
  if (pathname === "/control/review/event") return value.event !== null && typeof value.event === "object" || typeof value.seq === "number" && value.fragment !== null && typeof value.fragment === "object";
  if (pathname === "/control/folio/import") return value.cancelled === true || Array.isArray(value.completed) && Array.isArray(value.failed) && Array.isArray(value.paths) && ["applied", "partially_applied", "not_applied"].includes(value.outcome as string);
  if (pathname === "/control/folio/sync") return ["succeeded", "failed", "unsupported", "skipped"].includes(value.hostSyncStatus as string);
  return Object.keys(value).length > 0;
}

const readRoutes = new Set(["/control/document/read", "/control/document/outline", "/control/document/context", "/control/document/diff", "/control/review/thread", "/control/review/threads", "/control/review/event", "/control/review/pending", "/control/review/quote-candidates", "/control/review/operation", "/control/folio/list", "/control/folio/export"]);

/** Authenticated, bounded control client; transport failure never implies rollback. */
export async function controlRequest<T>(config: TetherConfig, pathname: string, body: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const discovery = await ensureDaemon({ config });
  const { readControlToken } = await import("./config");
  const token = await readControlToken(config);
  if (!token) throw new ControlRequestError("control_unavailable", "Daemon control credential is unavailable.", 503, { outcome: "not_applied" });
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new ControlRequestError("input_too_large", "Control request exceeds 40 MiB.", 413, { outcome: "not_applied" });
  const outcome = readRoutes.has(pathname) ? "not_applied" : "outcome_unknown";
  const recovery = { outcome, ...(typeof body.operationId === "string" ? { operationId: body.operationId, recovery: "Look up the operation receipt or retry with the same operation ID and input." } : outcome === "outcome_unknown" ? { recovery: "Inspect current state before retrying." } : {}) };
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    response = await fetch(`${discovery.origin}${pathname}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: serialized,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    throw new ControlRequestError("transport_unavailable", "Daemon request interrupted or timed out.", 503, recovery);
  }
  let payload: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 40 * 1024 * 1024) throw new Error("Response too large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    payload = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch { throw new ControlRequestError("invalid_response", "The daemon returned an invalid or incomplete response.", response.status, recovery); }
  if (!response.ok) {
    const issue = payload && typeof payload === "object" ? (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error : undefined;
    throw new ControlRequestError(
      typeof issue?.code === "string" ? issue.code : "control_failed",
      typeof issue?.message === "string" ? issue.message : "The daemon control request failed.",
      response.status,
      { ...recovery, ...(response.status === 400 && issue?.code === "invalid_request" ? { outcome: "not_applied" } : {}), ...(issue?.details && typeof issue.details === "object" ? issue.details : issue?.details === undefined ? {} : { detail: issue.details }) },
    );
  }
  if (!validateControlResponse(pathname, payload)) throw new ControlRequestError("invalid_response", "The daemon returned a malformed success response.", response.status, recovery);
  return payload as T;
}

export async function controlLaunch(config: TetherConfig, path: string, target?: HostTarget): Promise<{ url: string; expiresAt: number; path: string }> {
  return controlRequest(config, "/control/launch", { path, ...(target ? { target } : {}) });
}

export async function controlRecentsLaunch(config: TetherConfig, target?: HostTarget): Promise<{ url: string; expiresAt: number }> {
  return controlRequest(config, "/control/recents/launch", { ...(target ? { target } : {}) });
}

export async function controlRecentsAdd(
  config: TetherConfig,
  path: string,
  target?: HostTarget,
): Promise<{ path: string; recentCount: number; hostSynchronized: boolean }> {
  return controlRequest(config, "/control/recents/add", { path, ...(target ? { target } : {}) });
}

export async function cancelLaunch(config: TetherConfig, url: string): Promise<void> {
  const discovery = await discoverDaemon(config);
  if (!discovery) return;
  const ticket = new URL(url).searchParams.get("ticket");
  const { readControlToken } = await import("./config");
  const token = await readControlToken(config);
  if (!ticket || !token) return;
  await fetch(`${discovery.origin}/control/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(1000) }).catch(() => {});
}
