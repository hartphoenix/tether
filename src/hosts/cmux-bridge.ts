import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { readControlToken, readDiscovery, type TetherConfig } from "../server/config";
import { runtimeEntry } from "../runtime-paths";
import type { OpenLocalFileRequest, OpenViewRequest, OpenViewResult } from "./host-adapter";
import {
  createCmuxHost,
  SUPPORTED_CMUX_BUILD,
  SUPPORTED_CMUX_COMMIT,
  SUPPORTED_CMUX_VERSION,
} from "./cmux";

const LOOPBACK = "127.0.0.1";
const relaunchPath = process.env.TETHER_INSTALL_ROOT ? resolve(process.env.TETHER_INSTALL_ROOT, "tether") : runtimeEntry("cli");
const relaunchCommand = `'${relaunchPath.replace(/'/g, "'\\''")}' folio`;
const RELAUNCH = `Placement unavailable. In cmux, run: \`${relaunchCommand}\``;

export type CmuxBridgeRecord = {
  pid: number;
  origin: string;
  instanceId: string;
  daemonInstanceId: string;
  cmuxVersion: string;
  cmuxBuild: number;
  cmuxCommit: string;
  cmuxSocketFingerprint: string;
  startedAt: string;
};

export type CmuxBridgeStatus = {
  running: boolean;
  callbackPlacementReady: boolean;
  instanceId?: string;
  daemonInstanceId?: string;
  cmuxVersion?: string;
  cmuxBuild?: number;
  cmuxCommit?: string;
  cmuxSocketFingerprint?: string;
  startedAt?: string;
  issue?: { code: string; message: string };
};

export class CmuxBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503, readonly details?: unknown) {
    super(message);
    this.name = "CmuxBridgeError";
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function requireSupportedCmux(env: NodeJS.ProcessEnv): Promise<void> {
  const bundled = env.CMUX_BUNDLED_CLI_PATH;
  const fromPath = env.PATH?.split(delimiter).map((directory) => join(directory, "cmux")).find(existsSync);
  const host = createCmuxHost({ env, cmuxPath: bundled || fromPath || "/Applications/cmux.app/Contents/Resources/bin/cmux" });
  const detected = await host.detect();
  const actual = `${host.detectedVersion() ?? "unknown"} build ${host.detectedBuild() ?? "unknown"} commit ${host.detectedCommit() ?? "unknown"}`;
  if (!detected || host.detectedVersion() !== SUPPORTED_CMUX_VERSION || host.detectedBuild() !== SUPPORTED_CMUX_BUILD ||
    host.detectedCommit() !== SUPPORTED_CMUX_COMMIT) {
    throw new CmuxBridgeError(
      "unsupported_version",
      `Tether callbacks require cmux ${SUPPORTED_CMUX_VERSION} build ${SUPPORTED_CMUX_BUILD} commit ${SUPPORTED_CMUX_COMMIT}; detected ${actual}.`,
      400,
    );
  }
  await host.probeSocket();
}

export function fingerprintCmuxSocket(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

async function acquireBridgeLock(config: TetherConfig): Promise<{ release: () => Promise<void> } | null> {
  const path = `${config.cmuxBridgePath}.starting`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      return { release: () => rmdir(path).catch(() => {}) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 15_000) {
          await rmdir(path);
          continue;
        }
      } catch { continue; }
      return null;
    }
  }
  return null;
}

function validRecord(value: Partial<CmuxBridgeRecord>): value is CmuxBridgeRecord {
  if (!Number.isSafeInteger(value.pid) || !value.pid || value.pid < 1 || !alive(value.pid) ||
    typeof value.origin !== "string" || typeof value.instanceId !== "string" || !value.instanceId ||
    typeof value.daemonInstanceId !== "string" || !value.daemonInstanceId ||
    value.cmuxVersion !== SUPPORTED_CMUX_VERSION || value.cmuxBuild !== SUPPORTED_CMUX_BUILD || value.cmuxCommit !== SUPPORTED_CMUX_COMMIT ||
    typeof value.cmuxSocketFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.cmuxSocketFingerprint) ||
    typeof value.startedAt !== "string") return false;
  try {
    const origin = new URL(value.origin);
    return origin.protocol === "http:" && origin.hostname === LOOPBACK && Boolean(origin.port) &&
      !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash;
  } catch { return false; }
}

export async function readCmuxBridge(config: TetherConfig): Promise<CmuxBridgeRecord | null> {
  try {
    const value = JSON.parse(await readFile(config.cmuxBridgePath, "utf8")) as Partial<CmuxBridgeRecord>;
    return validRecord(value) ? value : null;
  } catch { return null; }
}

export async function writeCmuxBridge(config: TetherConfig, value: CmuxBridgeRecord): Promise<void> {
  const temporary = `${config.cmuxBridgePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, config.cmuxBridgePath);
  await chmod(config.cmuxBridgePath, 0o600).catch(() => {});
}

export async function removeCmuxBridge(config: TetherConfig, instanceId?: string): Promise<void> {
  if (instanceId) {
    const current = await readCmuxBridge(config);
    if (current && current.instanceId !== instanceId) return;
  }
  await unlink(config.cmuxBridgePath).catch(() => {});
}

async function bridgeRequest(config: TetherConfig, pathname: string, body?: unknown): Promise<Response> {
  const [record, token] = await Promise.all([readCmuxBridge(config), readControlToken(config)]);
  if (!record || !token) throw new CmuxBridgeError("bridge_relaunch_required", RELAUNCH);
  try {
    return await fetch(`${record.origin}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    throw new CmuxBridgeError("bridge_relaunch_required", RELAUNCH);
  }
}

async function bridgeIssue(response: Response, fallback: string): Promise<CmuxBridgeError> {
  try {
    const payload = await response.json() as { error?: { code?: unknown; message?: unknown; details?: unknown } };
    return new CmuxBridgeError(
      typeof payload.error?.code === "string" ? payload.error.code : "cmux_open_failed",
      payload.error?.code === "bridge_relaunch_required" ? RELAUNCH : typeof payload.error?.message === "string" ? payload.error.message : fallback,
      response.status,
      payload.error?.details,
    );
  } catch { return new CmuxBridgeError("cmux_open_failed", fallback, response.status); }
}

export async function cmuxBridgeHealthy(config: TetherConfig, expectedDaemonInstanceId?: string, expectedSocketFingerprint?: string): Promise<boolean> {
  try {
    const [record, discovery] = await Promise.all([readCmuxBridge(config), readDiscovery(config)]);
    if (!discovery) return false;
    if (!record || (expectedDaemonInstanceId && record.daemonInstanceId !== expectedDaemonInstanceId)) return false;
    if (expectedSocketFingerprint && record.cmuxSocketFingerprint !== expectedSocketFingerprint) return false;
    if (record.daemonInstanceId !== discovery.instanceId) return false;
    const response = await bridgeRequest(config, "/health");
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    return value.service === "tether-cmux-bridge" && value.instanceId === record.instanceId &&
      value.daemonInstanceId === record.daemonInstanceId && value.cmuxVersion === record.cmuxVersion &&
      value.cmuxBuild === record.cmuxBuild && value.cmuxCommit === record.cmuxCommit &&
      value.cmuxSocketFingerprint === record.cmuxSocketFingerprint && value.cmuxReady === true;
  } catch { return false; }
}

export async function cmuxBridgeStatus(config: TetherConfig): Promise<CmuxBridgeStatus> {
  const record = await readCmuxBridge(config);
  if (!record) return {
    running: false,
    callbackPlacementReady: false,
    issue: { code: "bridge_relaunch_required", message: RELAUNCH },
  };
  const base = {
    running: true,
    instanceId: record.instanceId,
    daemonInstanceId: record.daemonInstanceId,
    cmuxVersion: record.cmuxVersion,
    cmuxBuild: record.cmuxBuild,
    cmuxCommit: record.cmuxCommit,
    cmuxSocketFingerprint: record.cmuxSocketFingerprint,
    startedAt: record.startedAt,
  };
  try {
    const discovery = await readDiscovery(config);
    if (!discovery || discovery.instanceId !== record.daemonInstanceId) {
      return { ...base, callbackPlacementReady: false, issue: { code: "bridge_relaunch_required", message: RELAUNCH } };
    }
    const response = await bridgeRequest(config, "/health");
    const payload = await response.json() as {
      service?: unknown;
      instanceId?: unknown;
      daemonInstanceId?: unknown;
      cmuxVersion?: unknown;
      cmuxBuild?: unknown;
      cmuxCommit?: unknown;
      cmuxSocketFingerprint?: unknown;
      cmuxReady?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (response.ok && payload.cmuxReady === true && payload.service === "tether-cmux-bridge" &&
      payload.instanceId === record.instanceId && payload.daemonInstanceId === record.daemonInstanceId &&
      payload.cmuxVersion === record.cmuxVersion && payload.cmuxBuild === record.cmuxBuild && payload.cmuxCommit === record.cmuxCommit &&
      payload.cmuxSocketFingerprint === record.cmuxSocketFingerprint) return { ...base, callbackPlacementReady: true };
    return {
      ...base,
      callbackPlacementReady: false,
      issue: {
        code: typeof payload.error?.code === "string" ? payload.error.code : "bridge_relaunch_required",
        message: typeof payload.error?.message === "string" ? payload.error.message : RELAUNCH,
      },
    };
  } catch (cause) {
    return {
      ...base,
      callbackPlacementReady: false,
      issue: { code: cause instanceof CmuxBridgeError ? cause.code : "bridge_relaunch_required", message: cause instanceof Error ? cause.message : RELAUNCH },
    };
  }
}

export async function openThroughCmuxBridge(config: TetherConfig, request: OpenViewRequest): Promise<OpenViewResult> {
  const response = await bridgeRequest(config, "/open", request);
  if (!response.ok) throw await bridgeIssue(response, RELAUNCH);
  try {
    const payload = await response.json() as { opened?: unknown; launchConsumed?: unknown };
    if (payload.opened === true && typeof payload.launchConsumed === "boolean") {
      return { launchConsumed: payload.launchConsumed };
    }
  } catch { /* reported below */ }
  throw new CmuxBridgeError("invalid_response", "The cmux bridge returned an invalid open result.", 502);
}

export async function openLocalFileThroughCmuxBridge(config: TetherConfig, request: OpenLocalFileRequest): Promise<void> {
  const response = await bridgeRequest(config, "/open-local-file", request);
  if (!response.ok) throw await bridgeIssue(response, RELAUNCH);
  const payload = await response.json() as { opened?: unknown };
  if (payload.opened !== true) throw new CmuxBridgeError("invalid_response", "The cmux bridge returned an invalid file-open result.", 502);
}

export async function stopCmuxBridge(config: TetherConfig): Promise<void> {
  const current = await readCmuxBridge(config);
  if (!current) return;
  try { await bridgeRequest(config, "/stop", {}); } catch { /* already stopped */ }
  for (let index = 0; index < 40; index += 1) {
    const remaining = await readCmuxBridge(config);
    if (!remaining || remaining.instanceId !== current.instanceId) return;
    await Bun.sleep(25);
  }
  throw new CmuxBridgeError("bridge_stop_failed", "The previous cmux bridge did not stop.");
}

export async function waitForCmuxBridge(config: TetherConfig, daemonInstanceId: string, socketFingerprint: string, attempts = 100): Promise<CmuxBridgeRecord> {
  for (let index = 0; index < attempts; index += 1) {
    const record = await readCmuxBridge(config);
    if (record?.daemonInstanceId === daemonInstanceId && record.cmuxSocketFingerprint === socketFingerprint &&
      await cmuxBridgeHealthy(config, daemonInstanceId, socketFingerprint)) return record;
    await Bun.sleep(50);
  }
  throw new CmuxBridgeError("bridge_start_failed", "cmux bridge did not become ready. Relaunch Tether from a cmux terminal.");
}

export async function startCmuxBridge(
  config: TetherConfig,
  env = process.env,
  options: { wait?: boolean; cmuxVersion?: string; cmuxBuild?: number; cmuxCommit?: string } = {},
): Promise<CmuxBridgeRecord | null> {
  if (!env.CMUX_SOCKET_PATH || !env.CMUX_SOCKET_CAPABILITY) {
    throw new CmuxBridgeError("bridge_bootstrap_unsupported", "cmux bridge requires the signed socket capability from a cmux terminal.");
  }
  if ((options.cmuxVersion && options.cmuxVersion !== SUPPORTED_CMUX_VERSION) ||
    (options.cmuxBuild !== undefined && options.cmuxBuild !== SUPPORTED_CMUX_BUILD) ||
    (options.cmuxCommit && options.cmuxCommit !== SUPPORTED_CMUX_COMMIT)) {
    throw new CmuxBridgeError("unsupported_version", `Tether callbacks require cmux ${SUPPORTED_CMUX_VERSION} build ${SUPPORTED_CMUX_BUILD} commit ${SUPPORTED_CMUX_COMMIT}.`, 400);
  }
  await requireSupportedCmux(env);
  const socketFingerprint = fingerprintCmuxSocket(env.CMUX_SOCKET_PATH);
  const discovery = await readDiscovery(config);
  if (!discovery) throw new CmuxBridgeError("daemon_unavailable", "The Tether daemon must be running before the cmux bridge starts.");
  const lock = await acquireBridgeLock(config);
  if (!lock) return options.wait === false ? null : waitForCmuxBridge(config, discovery.instanceId, socketFingerprint);
  try {
    const existing = await readCmuxBridge(config);
    if (existing?.daemonInstanceId === discovery.instanceId && existing.cmuxSocketFingerprint === socketFingerprint &&
      await cmuxBridgeHealthy(config, discovery.instanceId, socketFingerprint)) return existing;
    await stopCmuxBridge(config);
    const childEnv: NodeJS.ProcessEnv = {
      PATH: env.PATH,
      TMPDIR: env.TMPDIR,
      LANG: env.LANG,
      LC_ALL: env.LC_ALL,
      CMUX_SOCKET_PATH: env.CMUX_SOCKET_PATH,
      CMUX_SOCKET_CAPABILITY: env.CMUX_SOCKET_CAPABILITY,
      CMUX_BUNDLED_CLI_PATH: env.CMUX_BUNDLED_CLI_PATH,
      CMUX_WORKSPACE_ID: env.CMUX_WORKSPACE_ID,
      CMUX_SURFACE_ID: env.CMUX_SURFACE_ID,
      TETHER_CMUX_VERSION: SUPPORTED_CMUX_VERSION,
      TETHER_CMUX_BUILD: String(SUPPORTED_CMUX_BUILD),
      TETHER_CMUX_COMMIT: SUPPORTED_CMUX_COMMIT,
      TETHER_CMUX_SOCKET_FINGERPRINT: socketFingerprint,
      TETHER_DAEMON_INSTANCE_ID: discovery.instanceId,
      TETHER_DAEMON_ORIGIN: discovery.origin,
      TETHER_PROFILE: config.profile,
      TETHER_RUNTIME_DIR: config.runtimeDir,
      TETHER_CONFIG_DIR: config.configDir,
      TETHER_INSTALL_ROOT: env.TETHER_INSTALL_ROOT,
    };
    // cmux 0.64.22 signs a capability into each terminal specifically so an
    // inherited child remains authorized after detachment and reparenting.
    // Keep that broad cmux authority only in this narrow bridge's environment.
    const child = Bun.spawn([process.execPath, runtimeEntry("cmux-bridge")], {
      env: childEnv,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return options.wait === false ? null : waitForCmuxBridge(config, discovery.instanceId, socketFingerprint);
  } finally { await lock.release(); }
}
