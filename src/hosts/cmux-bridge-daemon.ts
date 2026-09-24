import { diagnosticText, errorDetails } from "../shared/diagnostics";
import { PROTOCOL_VERSION, SERVICE_ID } from "../shared/contracts";
import { createCmuxHost, isSupportedCmuxVersion, MINIMUM_CMUX_VERSION } from "./cmux";
import { fingerprintCmuxSocket, removeCmuxBridge, writeCmuxBridge } from "./cmux-bridge";
import { prepareConfig, readControlToken, readDiscovery, resolveConfig } from "../server/config";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { HostTarget, OpenViewRequest } from "./host-adapter";
import { controlRequest } from "../server/lifecycle";
import type { RecoveryView } from "./recovery";

const config = resolveConfig();
await prepareConfig(config);
const [token, currentDiscovery] = await Promise.all([readControlToken(config), readDiscovery(config)]);
if (!token || !currentDiscovery) throw new Error("cmux bridge credentials or daemon discovery are unavailable.");
let discovery = currentDiscovery;
if (process.env.TETHER_DAEMON_INSTANCE_ID !== discovery.instanceId || process.env.TETHER_DAEMON_ORIGIN !== discovery.origin) {
  throw new Error("cmux bridge daemon identity does not match current discovery.");
}
if (!process.env.CMUX_SOCKET_PATH || process.env.TETHER_CMUX_SOCKET_FINGERPRINT !== fingerprintCmuxSocket(process.env.CMUX_SOCKET_PATH)) {
  throw new Error("cmux bridge socket identity does not match its signed environment.");
}
const cmuxSocketFingerprint = process.env.TETHER_CMUX_SOCKET_FINGERPRINT;

let cmuxVersion = process.env.TETHER_CMUX_VERSION ?? "";
let cmuxBuild = process.env.TETHER_CMUX_BUILD ? Number(process.env.TETHER_CMUX_BUILD) : null;
let cmuxCommit = process.env.TETHER_CMUX_COMMIT || null;
if (!isSupportedCmuxVersion(cmuxVersion)) throw new Error("Unsupported cmux bridge version.");
class BridgeServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

const host = createCmuxHost();
let hostCheck: Promise<void> | undefined;
let published = false;
async function requireSupportedCmux(): Promise<void> {
  if (hostCheck) return hostCheck;
  hostCheck = (async () => {
    const detected = await host.detect();
    if (!detected || !isSupportedCmuxVersion(host.detectedVersion())) {
      throw new BridgeBuildError(`Tether callbacks require cmux ${MINIMUM_CMUX_VERSION} or later; detected ${host.detectedVersion() ?? "unknown"}.`);
    }
    await host.probeContract();
    const changed = cmuxVersion !== host.detectedVersion() || cmuxBuild !== host.detectedBuild() || cmuxCommit !== host.detectedCommit();
    cmuxVersion = host.detectedVersion()!;
    cmuxBuild = host.detectedBuild();
    cmuxCommit = host.detectedCommit();
    if (changed && published) await publishRecord();
  })();
  try { await hostCheck; } finally { hostCheck = undefined; }
}

class BridgeBuildError extends Error {
  readonly code = "unsupported_version";
  readonly status = 400;
}

await requireSupportedCmux();

const instanceId = crypto.randomUUID();
let stopped = false;
const eventAbort = new AbortController();
let eventTask: Promise<void> | undefined;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryTask: Promise<void> = Promise.resolve();
const attempted = new Set<string>();
let recovering = false;
let recoveryDirty = false;
function scheduleRecovery(): void {
  if (stopped) return;
  recoveryDirty = true;
  if (recoveryTimer || recovering) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    recovering = true; recoveryDirty = false;
    recoveryTask = (async () => {
      if (stopped) return;
      if (!await currentDaemon()) return;
      const inventory = await controlRequest<{ views: RecoveryView[] }>(config, "/control/recovery/views", {}, { start: false });
      const views = inventory.views.filter(view => !attempted.has(view.id));
      const report = await host.recoverViews(views, false, eventAbort.signal);
      for (const result of report.results) if (result.status === "navigated" && result.viewId) attempted.add(result.viewId);
    })().finally(() => {
      recovering = false;
      if (recoveryDirty && !stopped) scheduleRecovery();
    });
    void recoveryTask.catch(() => {});
  }, 300);
}

let resolveClosed!: () => void;
const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestKeys = new Set(["url", "kind", "focus", "allowFocusedFallback", "targetPolicy", "sourceUrl", "target"]);
const targetKeys = new Set(["host", "version", "build", "commit", "windowId", "workspaceId", "surfaceId"]);


function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validTarget(value: unknown): HostTarget | null {
  const target = object(value);
  if (!target || Object.keys(target).some((key) => !targetKeys.has(key)) || target.host !== "cmux" ||
    !isSupportedCmuxVersion(target.version) ||
    !UUID.test(String(target.windowId ?? "")) ||
    !UUID.test(String(target.workspaceId ?? "")) || !UUID.test(String(target.surfaceId ?? ""))) return null;
  return Object.fromEntries(Object.entries(target).map(([key, entry]) => [key, String(entry)]));
}

function validateSourceUrl(value: unknown): asserts value is string {
  let url: URL;
  try { url = new URL(typeof value === "string" ? value : ""); }
  catch { throw new BridgeServiceError("invalid_target", "A source reader URL is required.", 400); }
  if (url.origin !== discovery.origin || !/^\/s\/[^/]+\/$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new BridgeServiceError("invalid_target", "Only a current Tether reader URL may identify the source pane.", 400);
  }
}

function openRequest(value: unknown): OpenViewRequest {
  const body = object(value);
  if (!body || Object.keys(body).some((key) => !requestKeys.has(key)) || typeof body.url !== "string" ||
    (body.kind !== "document" && body.kind !== "recents") || typeof body.focus !== "boolean" ||
    (body.allowFocusedFallback !== undefined && typeof body.allowFocusedFallback !== "boolean") ||
    (body.targetPolicy !== undefined && (body.kind !== "document" || !["focused-workspace", "source-pane"].includes(String(body.targetPolicy))))) {
    throw new BridgeServiceError("invalid_request", "A valid cmux open-view request is required.", 400);
  }
  const target = validTarget(body.target);
  if (!target) throw new BridgeServiceError("invalid_target", "A supported immutable cmux target is required.", 400);
  if (body.sourceUrl !== undefined) validateSourceUrl(body.sourceUrl);
  if (body.targetPolicy === "source-pane" && !body.sourceUrl) throw new BridgeServiceError("invalid_target", "A source reader URL is required.", 400);
  let destination: URL;
  try { destination = new URL(body.url); }
  catch { throw new BridgeServiceError("invalid_request", "A valid Tether launch URL is required.", 400); }
  const expectedPath = body.kind === "document" ? "/launch" : "/recents/launch";
  if (destination.origin !== discovery.origin || destination.pathname !== expectedPath || !destination.searchParams.get("ticket") ||
    destination.searchParams.size !== 1 || destination.hash || destination.username || destination.password) {
    throw new BridgeServiceError("invalid_request", "Only a current Tether launch URL of the requested kind may be opened.", 400);
  }
  return {
    url: destination.toString(),
    kind: body.kind,
    focus: body.focus,
    ...(body.allowFocusedFallback === undefined ? {} : { allowFocusedFallback: body.allowFocusedFallback }),
    ...(body.targetPolicy === undefined ? {} : { targetPolicy: body.targetPolicy as "focused-workspace" | "source-pane" }),
    ...(typeof body.sourceUrl === "string" ? { sourceUrl: body.sourceUrl } : {}),
    target,
  };
}

const workspaceChains = new Map<string, Promise<unknown>>();
async function serialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceChains.get(workspaceId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  workspaceChains.set(workspaceId, current);
  try { return await current; }
  finally { if (workspaceChains.get(workspaceId) === current) workspaceChains.delete(workspaceId); }
}

function issue(cause: unknown): { code: string; message: string; status: number; details?: unknown } {
  const value = object(cause);
  const code = typeof value?.code === "string" ? value.code : "cmux_open_failed";
  const status = typeof value?.status === "number" ? value.status
    : code === "placement_anchor_missing" || code === "target_missing" || code.startsWith("ambiguous_") ? 409
    : code === "socket_unauthorized" ? 403
    : code === "socket_unavailable" || code === "dock_unavailable" ? 503
    : 502;
  return {
    code,
    message: cause instanceof Error ? cause.message : String(cause),
    status,
    ...(value?.details === undefined ? {} : { details: value.details }),
  };
}

let refreshing: Promise<boolean> | undefined;
async function currentDaemon(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = await readDiscovery(config);
    if (current?.instanceId === discovery.instanceId && current.origin === discovery.origin) return true;
    if (!current) return false;
    // Verify a successor through the same profile's authenticated control API.
    // Keep the in-memory host capability while the service is unavailable.
    const response = await fetch(`${current.origin}/control/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const status = await response.json() as Record<string, unknown>;
    if (status.service !== SERVICE_ID || status.protocol !== PROTOCOL_VERSION || status.instanceId !== current.instanceId ||
        status.pid !== current.pid || status.origin !== current.origin) return false;
    discovery = current;
    attempted.clear();
    await publishRecord();
    scheduleRecovery();
    return true;
  })();
  try { return await refreshing; }
  finally { refreshing = undefined; }
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (!authorized(request)) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      if (!await currentDaemon()) {
        return json({ error: { code: "bridge_relaunch_required", message: "The Tether daemon instance changed." }, cmuxReady: false }, 503);
      }
      await requireSupportedCmux();
      return json({
        service: "tether-cmux-bridge",
        instanceId,
        daemonInstanceId: discovery.instanceId,
        cmuxVersion,
        cmuxBuild,
        cmuxCommit,
        cmuxSocketFingerprint,
        cmuxReady: true,
      });
    } catch (cause) {
      const error = issue(cause);
      return json({ error: { code: error.code, message: diagnosticText(error.message), details: errorDetails(cause) }, cmuxReady: false }, error.status);
    }
  }
  if (request.method === "POST" && url.pathname === "/prepare-restart") {
    const body = object(await request.json().catch(() => null));
    if (body?.daemonInstanceId !== discovery.instanceId || !await currentDaemon()) {
      return json({ error: { code: "bridge_relaunch_required", message: "The Tether daemon instance changed." } }, 409);
    }
    // Survive the restart only if placement still works; otherwise exit so the
    // next cmux terminal attaches a fresh bridge.
    try { await requireSupportedCmux(); }
    catch (cause) {
      setTimeout(() => void shutdown("cmux failed its check before a service restart"), 100);
      const error = issue(cause);
      return json({ error: { code: error.code, message: diagnosticText(error.message) } }, 409);
    }
    return json({ prepared: true });
  }
  if (request.method === "POST" && url.pathname === "/stop") {
    queueMicrotask(() => shutdown());
    return json({ stopping: true });
  }
  if (request.method === "POST" && url.pathname === "/open-local-file") {
    try {
      if (!await currentDaemon()) throw new BridgeServiceError("bridge_relaunch_required", "The Tether daemon instance changed.", 503);
      const body = object(await request.json());
      const target = validTarget(body?.target);
      if (!body || Object.keys(body).some((key) => !["path", "sourceUrl", "target"].includes(key)) || !target ||
          typeof body.path !== "string" || !isAbsolute(body.path) || body.path.includes("\0")) {
        throw new BridgeServiceError("invalid_request", "An absolute local file path and cmux target are required.", 400);
      }
      validateSourceUrl(body.sourceUrl);
      await requireSupportedCmux();
      await host.openLocalFile({ path: body.path, sourceUrl: body.sourceUrl, target });
      return json({ opened: true });
    } catch (cause) {
      const error = issue(cause);
      return json({ error: { code: error.code, message: diagnosticText(error.message), details: errorDetails(cause) } }, error.status);
    }
  }
  if (request.method === "POST" && url.pathname === "/open") {
    try {
      if (!await currentDaemon()) throw new BridgeServiceError("bridge_relaunch_required", "The Tether daemon instance changed.", 503);
      const body = openRequest(await request.json());
      await requireSupportedCmux();
      const result = await serialized(body.target!.workspaceId!, () => host.openView(body));
      return json({ opened: true, launchConsumed: result.launchConsumed });
    } catch (cause) {
      const error = issue(cause);
      // A malformed cmux response means this bridge can no longer be trusted.
      // Exit so the next cmux terminal (or `tether folio`) attaches a fresh one.
      if (error.code === "invalid_response" && typeof object(object(cause)?.details)?.operation === "string") {
        setTimeout(() => void shutdown("cmux returned a malformed response"), 100);
        return json({ error: { code: "bridge_relaunch_required", message: diagnosticText(error.message), ...(error.details === undefined ? {} : { details: error.details }) } }, 503);
      }
      return json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, error.status);
    }
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
} });

/** Why the bridge exited, for `tether doctor`-style diagnosis; bounded, no payloads. */
async function logExit(reason: string): Promise<void> {
  const path = join(config.runtimeDir, "cmux-bridge.log");
  const previous = await readFile(path, "utf8").catch(() => "");
  const lines = `${previous}${new Date().toISOString()} pid ${process.pid} exited: ${reason}\n`.split("\n").slice(-200).join("\n");
  await writeFile(path, lines, { mode: 0o600 }).catch(() => {});
}

async function shutdown(reason = "stop requested"): Promise<void> {
  if (stopped) return;
  stopped = true;
  await logExit(reason);
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  clearInterval(timer);
  clearTimeout(recoveryTimer);
  eventAbort.abort();
  server.stop(true);
  await eventTask?.catch(() => {});
  await recoveryTask.catch(() => {});
  await Promise.allSettled([...workspaceChains.values()]);
  await publication.catch(() => {});
  await removeCmuxBridge(config, instanceId);
  clearTimeout(deadline);
  resolveClosed();
}

/** The cmux process this bridge was launched from is still the one serving
 * its socket. A relaunched cmux recreates the socket and changes its fingerprint. */
async function sameHost(): Promise<boolean> {
  if (fingerprintCmuxSocket(process.env.CMUX_SOCKET_PATH!) !== cmuxSocketFingerprint) return false;
  try { await host.probeSocket(); return true; } catch { return false; }
}

/** A different socket at the same path is a new cmux process: exit at once.
 * Anything else (missing socket, slow ping during sleep or App Nap) must
 * persist before the bridge gives up its authority. */
function relaunched(): boolean {
  return existsSync(process.env.CMUX_SOCKET_PATH!) && fingerprintCmuxSocket(process.env.CMUX_SOCKET_PATH!) !== cmuxSocketFingerprint;
}
const LIVENESS_FAILURES = 3;
let failures = 0;
let eventsActive = false;
let checkingDaemon = false;
const timer = setInterval(async () => {
  if (checkingDaemon || stopped) return;
  checkingDaemon = true;
  try {
    if (relaunched()) { await shutdown("cmux relaunched"); return; }
    if (!eventsActive) {
      if (await sameHost()) { failures = 0; watch(); }
      else if (++failures >= LIVENESS_FAILURES) { await shutdown(`cmux unreachable for ${failures} consecutive checks`); return; }
    }
    await currentDaemon();
  } catch { /* Retry later; service gaps keep this cmux session's authority. */ }
  finally { checkingDaemon = false; }
}, 10_000);

const bridgeStartedAt = new Date().toISOString();
let publication = Promise.resolve();
function publishRecord(): Promise<void> {
  const next = publication.catch(() => {}).then(async () => {
    if (stopped) return;
    await writeCmuxBridge(config, {
    pid: process.pid,
    origin: `http://127.0.0.1:${server.port}`,
    instanceId,
    daemonInstanceId: discovery.instanceId,
    cmuxVersion,
    cmuxBuild,
    cmuxCommit,
    cmuxSocketFingerprint,
    startedAt: bridgeStartedAt,
  });
  });
  publication = next;
  return next;
}
await publishRecord();
published = true;
scheduleRecovery();
// The bridge lives exactly as long as this cmux process. Event streams can end
// while cmux stays up (sleep, idle); the timer re-watches once cmux answers.
// Fresh authority after cmux exits comes from the next cmux terminal.
function watch(): void {
  if (stopped || eventsActive) return;
  eventsActive = true;
  // The stream only signals cmux exit. Recovery runs on attach and service
  // change; probing panes on every focus or selection event competes with the
  // user's own clicks.
  eventTask = host.watchRecovery(() => {}, eventAbort.signal);
  void eventTask.catch(async () => {
    eventsActive = false;
    if (!stopped && relaunched()) await shutdown("cmux relaunched");
  });
}
watch();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));
await closed;
