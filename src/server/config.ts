import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DiscoveryRecord } from "../shared/contracts";
import { PROTOCOL_VERSION, SERVICE_ID } from "../shared/contracts";

/** Runtime and profile paths are deliberately outside a source checkout. */
export type TetherConfig = {
  profile: string;
  runtimeDir: string;
  configDir: string;
  discoveryPath: string;
  lockPath: string;
  controlPath: string;
  recentsPath: string;
  preferencesPath: string;
  waveBridgePath: string;
  cmuxBridgePath: string;
};

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateProfile(profile: string): string {
  if (!PROFILE_RE.test(profile) || profile === "." || profile === "..") {
    throw new Error("TETHER_PROFILE must contain 1–64 letters, numbers, underscores, or hyphens.");
  }
  return profile;
}

function defaultRuntimeRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "tether", "runtime");
  return process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "tether") : join(homedir(), ".local", "state", "tether");
}

function defaultConfigRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "tether", "config");
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "tether") : join(homedir(), ".config", "tether");
}

export function resolveConfig(input: Partial<Pick<TetherConfig, "profile" | "runtimeDir" | "configDir">> = {}): TetherConfig {
  const profile = validateProfile(input.profile ?? process.env.TETHER_PROFILE ?? "default");
  // Explicit overrides name the directory itself. Defaults are namespaced by
  // profile below the platform's per-user roots.
  const runtimeOverride = input.runtimeDir ?? process.env.TETHER_RUNTIME_DIR;
  const configOverride = input.configDir ?? process.env.TETHER_CONFIG_DIR;
  const runtimeDir = resolve(runtimeOverride ?? join(defaultRuntimeRoot(), profile));
  const configDir = resolve(configOverride ?? join(defaultConfigRoot(), profile));
  return {
    profile,
    runtimeDir,
    configDir,
    discoveryPath: join(runtimeDir, "discovery.json"),
    lockPath: join(runtimeDir, "startup.lock"),
    controlPath: join(runtimeDir, "control.token"),
    recentsPath: join(configDir, "recent-files.json"),
    preferencesPath: join(configDir, "preferences.json"),
    waveBridgePath: join(runtimeDir, "wave-bridge.json"),
    cmuxBridgePath: join(runtimeDir, "cmux-bridge.json"),
  };
}

export async function prepareConfig(config: TetherConfig): Promise<void> {
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  // chmod is needed when an existing directory was created too broadly.
  await chmod(config.runtimeDir, 0o700).catch(() => {});
  await chmod(config.configDir, 0o700).catch(() => {});
}

export async function readDiscovery(config: TetherConfig): Promise<DiscoveryRecord | null> {
  try {
    const value = JSON.parse(await readFile(config.discoveryPath, "utf8")) as Partial<DiscoveryRecord>;
    const pid = value.pid;
    if (value.protocol !== PROTOCOL_VERSION || typeof value.instanceId !== "string" || !value.instanceId ||
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.origin !== "string" ||
      typeof value.startedAt !== "string") return null;
    const origin = new URL(value.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) return null;
    return { protocol: PROTOCOL_VERSION, instanceId: value.instanceId, pid, origin: value.origin, startedAt: value.startedAt };
  } catch {
    return null;
  }
}

export async function writeDiscovery(config: TetherConfig, discovery: DiscoveryRecord): Promise<void> {
  await prepareConfig(config);
  const temporary = `${config.discoveryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(discovery), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, config.discoveryPath);
  await chmod(config.discoveryPath, 0o600).catch(() => {});
}

export async function removeDiscovery(config: TetherConfig, instanceId?: string): Promise<void> {
  if (instanceId) {
    const current = await readDiscovery(config);
    if (current && current.instanceId !== instanceId) return;
  }
  await unlink(config.discoveryPath).catch(() => {});
}

export async function readControlToken(config: TetherConfig): Promise<string | null> {
  try {
    const info = await stat(config.controlPath);
    if ((info.mode & 0o077) !== 0) return null;
    const token = (await readFile(config.controlPath, "utf8")).trim();
    return /^[A-Za-z0-9_-]{40,}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function ensureControlToken(config: TetherConfig): Promise<string> {
  await prepareConfig(config);
  const existing = await readControlToken(config);
  if (existing) return existing;
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const temporary = `${config.controlPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  try {
    // Avoid replacing another launcher's token. Both values are valid, and a
    // retry will read the winner.
    const handle = await open(config.controlPath, "wx", 0o600);
    await handle.writeFile(`${token}\n`);
    await handle.close();
    await unlink(temporary).catch(() => {});
    return token;
  } catch {
    await unlink(temporary).catch(() => {});
    const winner = await readControlToken(config);
    if (winner) return winner;
    throw new Error("Unable to create the private daemon control credential.");
  }
}

type LockHandle = { release: () => Promise<void> };

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockOwnerPid(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    return Number.isSafeInteger(parsed.pid) ? parsed.pid! : null;
  } catch { return null; }
}

/** Acquire the cross-process startup lock, recovering only demonstrably stale locks. */
export async function acquireStartupLock(config: TetherConfig): Promise<LockHandle> {
  await prepareConfig(config);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(config.lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return {
        release: async () => {
          const owner = await lockOwnerPid(config.lockPath);
          if (owner === process.pid) await unlink(config.lockPath).catch(() => {});
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await lockOwnerPid(config.lockPath);
      if (owner !== null && pidAlive(owner)) throw new Error("Another Tether daemon is starting.");
      await unlink(config.lockPath).catch(() => {});
    }
  }
  throw new Error("Unable to acquire the Tether startup lock.");
}

export async function removeStaleRuntime(config: TetherConfig): Promise<void> {
  await unlink(config.discoveryPath).catch(() => {});
  const owner = await lockOwnerPid(config.lockPath);
  if (owner === null || !pidAlive(owner)) await rm(config.lockPath, { force: true }).catch(() => {});
}

export { PROTOCOL_VERSION, SERVICE_ID };
