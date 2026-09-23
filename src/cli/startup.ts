import { lstat, mkdir, readFile, rmdir, unlink, writeFile, rename } from "node:fs/promises";
import { acquireFileLock } from "../documents/path-lock";
import { homedir } from "node:os";
import { join } from "node:path";
import { disableAutomation, enableAutomation, readAutomation } from "../server/automation-state";
import { cmuxStartupHook, runtimeFingerprint, startupGuard, startupLabel, startupPlist } from "../server/startup-assets";
import { statusDaemon, stopDaemon } from "../server/lifecycle";
import { readCmuxBridge, cmuxBridgeHealthy } from "../hosts/cmux-bridge";
import type { TetherConfig } from "../server/config";

type StartupOptions = { home?: string; root?: string; run?: (args: string[]) => Promise<number> };
const runner = async (args: string[]) => {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { return await child.exited; } finally { clearTimeout(timer); }
};
const jobPath = (config: TetherConfig, home: string) => join(home, "Library/LaunchAgents", `${startupLabel(config)}.plist`);
const jobTarget = (config: TetherConfig) => `gui/${process.getuid!()}/${startupLabel(config)}`;

export async function startupStatus(config: TetherConfig, options: StartupOptions = {}) {
  const state = await readAutomation(config);
  const loaded = await (options.run ?? runner)(["print", jobTarget(config)]) === 0;
  const daemon = await statusDaemon(config);
  const bridge = await readCmuxBridge(config);
  const daemonRunning = Boolean(state.daemon && daemon.running && !daemon.controlIssue && state.daemon.pid === daemon.pid);
  const bridgeRunning = Boolean(state.bridge && bridge?.pid === state.bridge.pid && await cmuxBridgeHealthy(config));
  const present = (name: string) => lstat(join(config.configDir, name)).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause; });
  const marker = await present("login-attempt"), attachMarker = await present("attach-attempt");
  return { enabled: state.enabled, loaded, blocked: Boolean(state.daemon && !daemonRunning || state.bridge && !bridgeRunning || marker && !daemonRunning || attachMarker && !bridgeRunning),
    markers: { login: marker, attach: attachMarker }, runtime: state.runtime?.root, daemon, attempts: { daemon: state.daemon, bridge: state.bridge }, target: jobTarget(config),
    plist: jobPath(config, options.home ?? homedir()), disableMarker: join(config.configDir, "startup-disabled") };
}

async function writeOwned(path: string, body: string, previous?: string): Promise<void> {
  const info = await lstat(path).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Unsafe startup asset: ${path}`);
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  if (existing !== undefined && existing !== body && existing !== previous) throw new Error(`Startup asset was changed; preserved: ${path}`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function enableStartup(config: TetherConfig, options: StartupOptions = {}) {
  if (process.platform !== "darwin") throw new Error("Login startup requires macOS.");
  const root = options.root ?? process.env.TETHER_INSTALL_ROOT;
  if (!root) throw new Error("Login startup requires a packaged installation; source checkouts are not registered.");
  const previous = await readAutomation(config);
  return withStartupAssets(config, async () => {
  if ((await statusDaemon(config)).running || await readCmuxBridge(config)) throw new Error("Stop Tether before enabling or resetting startup.");
  const digest = await runtimeFingerprint(root);
  const home = options.home ?? homedir();
  const run = options.run ?? runner;
  const disabledGeneration = await disableAutomation(config, false, previous.generation);
  const label = jobTarget(config);
  if (await run(["print", label]) === 0 && await run(["bootout", label]) !== 0) throw new Error("The old login job could not be unloaded; startup remains disabled.");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  const path = jobPath(config, home);
  await writeOwned(path, startupPlist(config));
  await writeOwned(join(config.configDir, "login-guard.sh"), startupGuard(config, root), previous.runtime ? startupGuard(config, previous.runtime.root) : undefined);
  await writeOwned(join(config.configDir, "cmux-startup.sh"), cmuxStartupHook(config, root), previous.runtime ? cmuxStartupHook(config, previous.runtime.root) : undefined);
  await rmdir(join(config.configDir, "login-attempt")).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
  await rmdir(join(config.configDir, "attach-attempt")).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
  const enabledGeneration = await enableAutomation(config, { root, digest }, disabledGeneration);
  try {
    if (await run(["bootstrap", `gui/${process.getuid!()}`, path]) !== 0) throw new Error("Login registration failed.");
    const registered = await readAutomation(config);
    if (!registered.enabled || registered.generation !== enabledGeneration) throw new Error("Login registration was cancelled.");
  } catch (cause) {
    if ((await readAutomation(config)).generation === enabledGeneration) await disableAutomation(config, false, enabledGeneration);
    await run(["bootout", label]);
    throw cause;
  }
  return { enabled: true, target: label, disableMarker: join(config.configDir, "startup-disabled"), plist: path, hook: join(config.configDir, "cmux-startup.sh"), message: "Login startup is registered. Source the generated hook from your interactive cmux shell to attach fresh host authority. Browser-only restoration is not guaranteed." };
  });
}

export async function disableStartup(config: TetherConfig, options: StartupOptions = {}) {
  await disableAutomation(config);
  return withStartupAssets(config, async () => {
  const run = options.run ?? runner;
  const target = jobTarget(config);
  const loaded = await run(["print", target]) === 0;
  const unloaded = !loaded || await run(["bootout", target]) === 0;
  let stopped = false;
  try {
    await stopDaemon(config);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await statusDaemon(config).catch(() => null);
      if (status && !status.running) { stopped = true; break; }
      await Bun.sleep(100);
    }
  } catch { /* Report incomplete cleanup; disabled intent remains durable. */ }
  const path = jobPath(config, options.home ?? homedir());
  let preserved = false;
  try {
    if (await readFile(path, "utf8") === startupPlist(config)) await unlink(path);
    else preserved = true;
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  return { enabled: false, unloaded, stopped, preserved, disableMarker: join(config.configDir, "startup-disabled") };
  });
}

async function withStartupAssets<T>(config: TetherConfig, action: () => Promise<T>): Promise<T> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    let lock;
    try { lock = await acquireFileLock(join(config.configDir, "startup-assets.lock")); }
    catch (cause) { if ((cause as { code?: string }).code !== "writer_busy" || attempt >= 200) throw cause; await Bun.sleep(100); continue; }
    try { return await action(); } finally { await lock.release(); }
  }
}
