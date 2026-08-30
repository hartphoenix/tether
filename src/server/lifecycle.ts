import { readDiscovery, acquireStartupLock, prepareConfig, removeStaleRuntime, resolveConfig, type TetherConfig } from "./config";
import { PROTOCOL_VERSION, SERVICE_ID, type DiscoveryRecord } from "../shared/contracts";

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
  return [process.execPath, `${import.meta.dir}/daemon.ts`, "serve"];
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

export async function controlLaunch(config: TetherConfig, path: string): Promise<{ url: string; expiresAt: number; path: string }> {
  const discovery = await ensureDaemon({ config });
  const { readControlToken } = await import("./config");
  const token = await readControlToken(config);
  if (!token) throw new Error("Daemon control credential is unavailable.");
  const response = await fetch(`${discovery.origin}/control/launch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path }) });
  const payload = await response.json() as { url?: string; expiresAt?: number; path?: string; error?: { message?: string } };
  if (!response.ok || !payload.url || !payload.expiresAt || !payload.path) throw new Error(payload.error?.message ?? "Unable to create a launch ticket.");
  return { url: payload.url, expiresAt: payload.expiresAt, path: payload.path };
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
