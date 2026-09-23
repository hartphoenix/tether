import { lstat, mkdir, open, readFile, rename, rmdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "../documents/path-lock";

export type AutomationConfig = { configDir: string };
export type Attempt = { id: string; generation: string; pid: number; role: "daemon" | "bridge" };
export type AutomationState = {
  version: 1;
  generation: string;
  enabled: boolean;
  runtime?: { root: string; digest: string };
  daemon?: Attempt;
  bridge?: Attempt;
};
const file = (config: AutomationConfig) => join(config.configDir, "automation.json");
const disabled = (): AutomationState => ({ version: 1, generation: crypto.randomUUID(), enabled: false });

/** Missing state is opt-out; malformed or unsafe state fails closed. */
export async function readAutomation(config: AutomationConfig): Promise<AutomationState> {
  try {
    const info = await lstat(file(config));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Unsafe automation state.");
    const state = JSON.parse(await readFile(file(config), "utf8")) as AutomationState;
    if (state.version !== 1 || typeof state.generation !== "string" || typeof state.enabled !== "boolean") throw new Error("Invalid automation state.");
    for (const role of ["daemon", "bridge"] as const) {
      const attempt = state[role];
      if (attempt && (attempt.role !== role || typeof attempt.id !== "string" || typeof attempt.generation !== "string" || !Number.isSafeInteger(attempt.pid) || attempt.pid <= 0)) throw new Error("Invalid automation attempt.");
    }
    if (state.enabled && (!state.runtime || typeof state.runtime.root !== "string" || !/^[a-f0-9]{64}$/.test(state.runtime.digest))) throw new Error("Invalid automation runtime.");
    if (await lstat(join(config.configDir, "startup-disabled")).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause; })) state.enabled = false;
    return state;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ...disabled(), generation: "unconfigured" };
    throw cause;
  }
}

async function writeState(config: AutomationConfig, state: AutomationState): Promise<void> {
  const path = file(config);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(state) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(config.configDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function automationTransaction<T>(config: AutomationConfig, action: (state: AutomationState, save: (state: AutomationState) => Promise<void>) => Promise<T>): Promise<T> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  const info = await lstat(config.configDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe automation directory.");
  const lock = await automationLock(config);
  try { return await action(await readAutomation(config), state => writeState(config, state)); }
  finally { await lock.release(); }
}

export async function enableAutomation(config: AutomationConfig, runtime: NonNullable<AutomationState["runtime"]>, expectedGeneration?: string): Promise<string> {
  return automationTransaction(config, async (state, save) => {
    if (expectedGeneration !== undefined && state.generation !== expectedGeneration) throw new Error("Startup enable was cancelled by a newer decision.");
    const next = { ...disabled(), enabled: true, runtime };
    await save(next);
    await unlink(join(config.configDir, "startup-disabled")).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
    return next.generation;
  });
}

/** Disable works even with malformed app state: it never imports the server. */
export async function disableAutomation(config: AutomationConfig, preserveDisabledGeneration = false, expectedGeneration?: string): Promise<string> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  const info = await lstat(config.configDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe automation directory.");
  const lock = await automationLock(config);
  try {
    const previous = await readAutomation(config).catch(() => undefined);
    if (expectedGeneration !== undefined && previous?.generation !== expectedGeneration) throw new Error("Startup enable was cancelled by a newer decision.");
    const marker = join(config.configDir, "startup-disabled");
    try { await writeFile(marker, "disabled\n", { mode: 0o600, flag: "wx" }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; const info = await lstat(marker); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe disable marker."); }
    const next = { ...disabled(), ...(preserveDisabledGeneration && previous && !previous.enabled ? { generation: previous.generation } : {}), ...(previous?.runtime ? { runtime: previous.runtime } : {}) };
    await writeState(config, next);
    return next.generation;
  } finally { await lock.release(); }
}

async function automationLock(config: AutomationConfig) {
  for (let attempt = 0; ; attempt++) {
    try { return await acquireFileLock(join(config.configDir, "automation.lock")); }
    catch (cause) {
      if ((cause as { code?: string }).code !== "writer_busy" || attempt >= 100) throw cause;
      await Bun.sleep(20);
    }
  }
}

export async function beginAttempt(config: AutomationConfig, role: Attempt["role"], runtime: NonNullable<AutomationState["runtime"]>): Promise<Attempt> {
  return automationTransaction(config, async (state, save) => {
    if (!state.enabled || state.runtime?.root !== runtime.root || state.runtime.digest !== runtime.digest) throw new Error("Automatic startup is disabled or the runtime changed.");
    if (state[role]) throw new Error(`Automatic ${role} startup is blocked by an unfinished attempt. Inspect it before explicitly enabling startup again.`);
    const attempt: Attempt = { role, generation: state.generation, id: crypto.randomUUID(), pid: process.pid };
    await save({ ...state, [role]: attempt });
    return attempt;
  });
}

export function ownsAttempt(state: AutomationState, attempt: Attempt): boolean {
  return state.enabled && state.generation === attempt.generation && state[attempt.role]?.id === attempt.id;
}

export async function completeAttempt(config: AutomationConfig, attempt: Attempt): Promise<void> {
  await automationTransaction(config, async (state, save) => {
    if (!ownsAttempt(state, attempt)) return;
    const next = { ...state }; delete next[attempt.role];
    await rmdir(join(config.configDir, attempt.role === "daemon" ? "login-attempt" : "attach-attempt")).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
    await save(next);
  });
}

export async function claimAttempt(config: AutomationConfig, attempt: Attempt): Promise<Attempt> {
  return automationTransaction(config, async (state, save) => {
    if (!ownsAttempt(state, attempt)) throw new Error("Automatic startup was cancelled.");
    const claimed = { ...attempt, pid: process.pid };
    await save({ ...state, [attempt.role]: claimed });
    return claimed;
  });
}

export async function transferAttempt(config: AutomationConfig, previous: Attempt): Promise<Attempt> {
  return automationTransaction(config, async (state, save) => {
    if (!ownsAttempt(state, previous)) throw new Error("Restart was cancelled.");
    const next = { ...previous, id: crypto.randomUUID() };
    await save({ ...state, [previous.role]: next });
    return next;
  });
}
