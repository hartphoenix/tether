import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { HostCapabilities } from "../shared/contracts";
import { readControlToken, type TetherConfig } from "../server/config";
import type { HostAdapter, HostTarget } from "./host-adapter";
import { SUPPORTED_WAVE_VERSION } from "./wave";

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
    if (origin.protocol !== "http:" || origin.hostname !== LOOPBACK || !origin.port) return null;
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
  } catch { throw new Error("Wave bridge unavailable. Relaunch Tether from Wave."); }
}

export async function waveBridgeHealthy(config: TetherConfig): Promise<boolean> {
  try { return (await bridgeRequest(config, "/health")).ok; } catch { return false; }
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

export async function startWaveBridge(config: TetherConfig, env = process.env): Promise<WaveBridgeRecord> {
  if (!env.WAVETERM_JWT) throw new Error("Wave bridge requires WAVETERM_JWT.");
  await stopWaveBridge(config);
  const childEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH, TMPDIR: env.TMPDIR, LANG: env.LANG, LC_ALL: env.LC_ALL,
    WAVETERM: "1", TERM_PROGRAM: "waveterm", WAVETERM_JWT: env.WAVETERM_JWT,
    WAVETERM_WORKSPACEID: env.WAVETERM_WORKSPACEID, WAVETERM_TABID: env.WAVETERM_TABID,
    TETHER_PROFILE: config.profile, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_CONFIG_DIR: config.configDir,
  };
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/wave-bridge-daemon.ts`], {
    env: childEnv, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  child.unref();
  return waitForWaveBridge(config);
}

const browserCapabilities: HostCapabilities = {
  embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true,
};

export class HostGateway implements HostAdapter {
  readonly id = "browser" as const;
  constructor(private readonly config: TetherConfig, private readonly fallback: HostAdapter) {}
  async detect(): Promise<boolean> { return true; }
  capabilities(target?: HostTarget): HostCapabilities {
    if (target?.host !== "wave") return this.fallback.capabilities(target);
    return {
      embeddedBrowser: true,
      hiddenNavigation: target.version === SUPPORTED_WAVE_VERSION,
      widgetInstallation: true,
      fileNavigatorHook: false,
      revealFile: true,
    };
  }
  async openView(url: string, target?: HostTarget): Promise<void> {
    if (target?.host !== "wave") return this.fallback.openView(url, target);
    const response = await bridgeRequest(this.config, "/open", { url, target });
    if (!response.ok) {
      let message = "Wave bridge could not open the view. Relaunch Tether from Wave.";
      try { message = ((await response.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { /* use default */ }
      throw new Error(message);
    }
  }
  openExternal(pathOrUrl: string): Promise<void> { return this.fallback.openExternal(pathOrUrl); }
  revealFile(path: string): Promise<void> { return this.fallback.revealFile?.(path) ?? Promise.resolve(); }
}

export function waveCapabilitiesUnavailable(): HostCapabilities { return { ...browserCapabilities }; }
