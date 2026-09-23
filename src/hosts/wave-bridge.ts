import { operationError } from "../shared/diagnostics";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { prepareConfig, readControlToken, type TetherConfig } from "../server/config";
import { runtimeEntry } from "../runtime-paths";
import type { OpenViewRequest } from "./host-adapter";
import type { RecentEntry } from "../recents/registry";
import { acquireFileLock } from "../documents/path-lock";
import { createWaveHost } from "./wave";

const LOOPBACK = "127.0.0.1";

export type WaveBridgeRecord = { pid: number; origin: string; instanceId: string; startedAt: string };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function readWaveBridge(config: TetherConfig): Promise<WaveBridgeRecord | null> {
  try {
    const value = JSON.parse(await readFile(config.waveBridgePath, "utf8")) as Partial<WaveBridgeRecord>;
    if (!Number.isSafeInteger(value.pid) || !value.pid || value.pid < 1 || !alive(value.pid) ||
      typeof value.origin !== "string" || typeof value.instanceId !== "string" || typeof value.startedAt !== "string") return null;
    const origin = new URL(value.origin);
    if (origin.protocol !== "http:" || origin.hostname !== LOOPBACK || !origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return value as WaveBridgeRecord;
  } catch { return null; }
}

export async function writeWaveBridge(config: TetherConfig, value: WaveBridgeRecord): Promise<void> {
  const temporary = `${config.waveBridgePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, config.waveBridgePath);
  await chmod(config.waveBridgePath, 0o600).catch(() => {});
}

export async function removeWaveBridge(config: TetherConfig, instanceId?: string): Promise<void> {
  if (instanceId) {
    const current = await readWaveBridge(config);
    if (current && current.instanceId !== instanceId) return;
  }
  await unlink(config.waveBridgePath).catch(() => {});
}

async function bridgeRequest(config: TetherConfig, pathname: string, body?: unknown): Promise<Response> {
  const record = await readWaveBridge(config);
  const token = await readControlToken(config);
  if (!record || !token) throw new Error("Wave bridge unavailable. Relaunch Tether from Wave.");
  try {
    return await fetch(`${record.origin}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch (cause) { throw operationError(cause, { stage: "wave_bridge" }); }
}

async function requireBridgeSuccess(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  let issue: { code?: string; message?: string; details?: unknown } | undefined;
  try { issue = (await response.json() as { error?: typeof issue }).error; } catch { /* Preserve status if body is unreadable. */ }
  throw Object.assign(new Error(issue?.message ?? fallback), { code: issue?.code ?? "wave_bridge_failed", status: response.status, details: issue?.details });
}

export async function openThroughWaveBridge(config: TetherConfig, request: OpenViewRequest): Promise<void> {
  await requireBridgeSuccess(await bridgeRequest(config, "/open", request), "Wave bridge could not open the view. Relaunch Tether from Wave.");
}

export async function updateWaveRecentsThroughBridge(config: TetherConfig, entries: RecentEntry[]): Promise<void> {
  await waitForWaveBridge(config, 40);
  await requireBridgeSuccess(await bridgeRequest(config, "/recents", { entries }), "Wave bridge could not update recent launchers.");
}

export async function waveBridgeHealthy(config: TetherConfig): Promise<boolean> {
  try {
    const record = await readWaveBridge(config);
    const response = await bridgeRequest(config, "/health");
    const health = await response.json() as { service?: string; instanceId?: string };
    return response.ok && health.service === "tether-wave-bridge" && health.instanceId === record?.instanceId;
  } catch { return false; }
}

export async function stopWaveBridge(config: TetherConfig): Promise<void> {
  const current = await readWaveBridge(config);
  if (!current) return;
  try { await bridgeRequest(config, "/stop", {}); } catch { /* already stopped */ }
  for (let index = 0; index < 40; index += 1) {
    const remaining = await readWaveBridge(config);
    if (!remaining || remaining.instanceId !== current.instanceId) return;
    await Bun.sleep(25);
  }
  throw new Error("The previous Wave bridge did not stop.");
}

export async function waitForWaveBridge(config: TetherConfig, attempts = 100): Promise<WaveBridgeRecord> {
  for (let index = 0; index < attempts; index += 1) {
    const record = await readWaveBridge(config);
    if (record && await waveBridgeHealthy(config)) return record;
    await Bun.sleep(50);
  }
  throw new Error("Wave bridge did not become ready.");
}

export async function startWaveBridge(config: TetherConfig, env = process.env, options: { wait?: boolean } = {}): Promise<WaveBridgeRecord | null> {
  if (!env.WAVETERM_JWT) throw new Error("Wave bridge requires WAVETERM_JWT.");
  await prepareConfig(config);
  let lock;
  try { lock = await acquireFileLock(`${config.waveBridgePath}.lock`); }
  catch (cause) {
    if ((cause as { code?: string }).code !== "writer_busy") throw cause;
    return options.wait === false ? null : waitForWaveBridge(config);
  }
  try {
    const existing = await readWaveBridge(config);
    if (existing) {
      if (!await waveBridgeHealthy(config)) throw new Error("The Wave bridge is still running but could not be reached. Retry without replacing its retained access.");
      const health = await (await bridgeRequest(config, "/health")).json() as { hostReady?: boolean };
      if (health.hostReady !== false) return existing;
      // Replace an obsolete credential only after the new launcher proves access.
      // A temporarily unavailable host leaves the retained bridge intact.
      await createWaveHost({ env }).probeConnection();
    }
    await stopWaveBridge(config);
    const childEnv: NodeJS.ProcessEnv = {
      PATH: env.PATH, TMPDIR: env.TMPDIR, LANG: env.LANG, LC_ALL: env.LC_ALL,
      WAVETERM: "1", TERM_PROGRAM: "waveterm", WAVETERM_JWT: env.WAVETERM_JWT,
      WAVETERM_WSHBINARY: env.WAVETERM_WSHBINARY,
      WAVETERM_WORKSPACEID: env.WAVETERM_WORKSPACEID, WAVETERM_TABID: env.WAVETERM_TABID,
      TETHER_PROFILE: config.profile, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_CONFIG_DIR: config.configDir,
      TETHER_INSTALL_ROOT: env.TETHER_INSTALL_ROOT,
    };
    const child = Bun.spawn([process.execPath, runtimeEntry("wave-bridge")], {
      env: childEnv, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    child.unref();
    // Hold the launch lock through publication even for background callers.
    return await waitForWaveBridge(config);
  } finally { await lock.release(); }
}
