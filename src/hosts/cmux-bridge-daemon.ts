import { PROTOCOL_VERSION, SERVICE_ID } from "../shared/contracts";
import { createCmuxHost, SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT, SUPPORTED_CMUX_VERSION } from "./cmux";
import { fingerprintCmuxSocket, removeCmuxBridge, writeCmuxBridge } from "./cmux-bridge";
import { prepareConfig, readControlToken, readDiscovery, resolveConfig } from "../server/config";
import { isAbsolute } from "node:path";
import type { HostTarget, OpenViewRequest } from "./host-adapter";

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

const host = createCmuxHost();
async function requireSupportedCmux(): Promise<void> {
  const detected = await host.detect();
  if (!detected || host.detectedVersion() !== SUPPORTED_CMUX_VERSION || host.detectedBuild() !== SUPPORTED_CMUX_BUILD ||
    host.detectedCommit() !== SUPPORTED_CMUX_COMMIT) {
    const actual = `${host.detectedVersion() ?? "unknown"} build ${host.detectedBuild() ?? "unknown"} commit ${host.detectedCommit() ?? "unknown"}`;
    throw new BridgeBuildError(
      `Tether callbacks require cmux ${SUPPORTED_CMUX_VERSION} build ${SUPPORTED_CMUX_BUILD} commit ${SUPPORTED_CMUX_COMMIT}; detected ${actual}.`,
    );
  }
  await host.probeSocket();
}

class BridgeBuildError extends Error {
  readonly code = "unsupported_version";
  readonly status = 400;
}

await requireSupportedCmux();

const instanceId = crypto.randomUUID();
if (process.env.TETHER_CMUX_VERSION !== SUPPORTED_CMUX_VERSION || process.env.TETHER_CMUX_BUILD !== String(SUPPORTED_CMUX_BUILD) ||
  process.env.TETHER_CMUX_COMMIT !== SUPPORTED_CMUX_COMMIT) throw new Error("Unsupported cmux bridge build identity.");
const cmuxVersion = SUPPORTED_CMUX_VERSION;
const cmuxBuild = SUPPORTED_CMUX_BUILD;
const cmuxCommit = SUPPORTED_CMUX_COMMIT;
let stopped = false;
let resolveClosed!: () => void;
const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestKeys = new Set(["url", "kind", "focus", "allowFocusedFallback", "targetPolicy", "sourceUrl", "target"]);
const targetKeys = new Set(["host", "version", "build", "commit", "windowId", "workspaceId", "surfaceId"]);

class BridgeServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validTarget(value: unknown): HostTarget | null {
  const target = object(value);
  if (!target || Object.keys(target).some((key) => !targetKeys.has(key)) || target.host !== "cmux" ||
    target.version !== SUPPORTED_CMUX_VERSION || target.build !== String(SUPPORTED_CMUX_BUILD) || target.commit !== SUPPORTED_CMUX_COMMIT ||
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

let restartUntil = 0;
let refreshing: Promise<boolean> | undefined;
async function currentDaemon(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = await readDiscovery(config);
    if (current?.instanceId === discovery.instanceId && current.origin === discovery.origin) return true;
    if (!current || Date.now() >= restartUntil) return false;
    // A controlled restart may renew the binding once. Verify the successor
    // through the profile's authenticated control API before trusting its URL.
    const response = await fetch(`${current.origin}/control/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const status = await response.json() as Record<string, unknown>;
    if (status.service !== SERVICE_ID || status.protocol !== PROTOCOL_VERSION || status.instanceId !== current.instanceId ||
        status.pid !== current.pid || status.origin !== current.origin) return false;
    await requireSupportedCmux();
    await publishRecord(current.instanceId);
    discovery = current;
    restartUntil = 0;
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
      return json({ error: { code: error.code, message: error.message }, cmuxReady: false }, error.status);
    }
  }
  if (request.method === "POST" && url.pathname === "/prepare-restart") {
    const body = object(await request.json().catch(() => null));
    if (body?.daemonInstanceId !== discovery.instanceId || !await currentDaemon()) {
      return json({ error: { code: "bridge_relaunch_required", message: "The Tether daemon instance changed." } }, 409);
    }
    restartUntil = Date.now() + 30_000;
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
      return json({ error: { code: error.code, message: error.message } }, error.status);
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
      return json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, error.status);
    }
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
} });

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  server.stop(true);
  await removeCmuxBridge(config, instanceId);
  resolveClosed();
}

let checkingDaemon = false;
const timer = setInterval(async () => {
  if (checkingDaemon || stopped) return;
  checkingDaemon = true;
  try {
    if (!await currentDaemon() && Date.now() >= restartUntil) await shutdown();
  } catch { if (Date.now() >= restartUntil) await shutdown(); }
  finally { checkingDaemon = false; }
}, 10_000);

async function publishRecord(daemonInstanceId: string): Promise<void> {
  await writeCmuxBridge(config, {
    pid: process.pid,
    origin: `http://127.0.0.1:${server.port}`,
    instanceId,
    daemonInstanceId,
    cmuxVersion,
    cmuxBuild,
    cmuxCommit,
    cmuxSocketFingerprint,
    startedAt: new Date().toISOString(),
  });
}
await publishRecord(discovery.instanceId);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());
await closed;
