import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cmuxHookPath, cmuxStartupHook, startupLabel, startupLogPath, startupPlist } from "../server/startup-assets";
import { statusDaemon } from "../server/lifecycle";
import { cmuxBridgeStatus } from "../hosts/cmux-bridge";
import type { TetherConfig } from "../server/config";

type StartupOptions = { home?: string; root?: string; run?: (args: string[]) => Promise<number> };
const runner = async (args: string[]) => {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { return await child.exited; } finally { clearTimeout(timer); }
};
const jobPath = (config: TetherConfig, home: string) => join(home, "Library/LaunchAgents", `${startupLabel(config)}.plist`);
const jobTarget = (config: TetherConfig) => `gui/${process.getuid!()}/${startupLabel(config)}`;
const hookLine = (config: TetherConfig) => `[ -r '${cmuxHookPath(config).replaceAll("'", "'\\''")}' ] && . '${cmuxHookPath(config).replaceAll("'", "'\\''")}'`;
const exists = (path: string) => lstat(path).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause; });

export async function startupStatus(config: TetherConfig, options: StartupOptions = {}) {
  const plist = jobPath(config, options.home ?? homedir());
  const enabled = await exists(plist);
  const loaded = await (options.run ?? runner)(["print", jobTarget(config)]) === 0;
  const [daemon, cmux] = await Promise.all([statusDaemon(config), cmuxBridgeStatus(config)]);
  // macOS lists Bun-based agents under Bun's developer name; if that background
  // item is switched off, launchd silently skips the job at login.
  const issue = enabled && !loaded ? { code: "login_job_not_loaded", message: "Login startup is enabled but macOS did not load it. In System Settings > General > Login Items & Extensions > Allow in the Background, turn on \"Jarred Sumner\" (Bun), then run `tether startup enable`." } : undefined;
  return { enabled, loaded, ...(issue ? { issue } : {}), plist, log: startupLogPath(config), hook: cmuxHookPath(config), hookInstalled: await exists(cmuxHookPath(config)), shellLine: hookLine(config),
    daemon: { running: daemon.running, pid: daemon.pid }, cmux: { attached: cmux.callbackPlacementReady, ...(cmux.issue ? { issue: cmux.issue } : {}) } };
}

async function writeAsset(path: string, body: string): Promise<void> {
  const info = await lstat(path).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Unsafe startup asset: ${path}`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function removeAsset(path: string): Promise<void> {
  const info = await lstat(path).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
  if (info && info.isFile() && !info.isSymbolicLink()) await unlink(path);
}

/** Registers login startup for the installation's current release. Enabling
 * again is harmless; updates keep working because the job follows `current`. */
export async function enableStartup(config: TetherConfig, options: StartupOptions = {}) {
  if (process.platform !== "darwin") throw new Error("Login startup requires macOS.");
  const root = options.root ?? process.env.TETHER_INSTALL_ROOT;
  if (!root) throw new Error("Login startup requires a packaged installation; source checkouts are not registered.");
  const installBase = dirname(dirname(root));
  const run = options.run ?? runner;
  const home = options.home ?? homedir();
  const path = jobPath(config, home);
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  await writeAsset(path, startupPlist(config, installBase));
  await writeAsset(cmuxHookPath(config), cmuxStartupHook(config, installBase));
  const target = jobTarget(config);
  if (await run(["print", target]) === 0) await run(["bootout", target]);
  if (await run(["bootstrap", `gui/${process.getuid!()}`, path]) !== 0) throw new Error(`Login registration failed. Check that "Jarred Sumner" (Bun) is allowed in System Settings > General > Login Items & Extensions > Allow in the Background, then retry. The job file is at ${path}; \`tether startup disable\` removes it.`);
  return { enabled: true, plist: path, hook: cmuxHookPath(config), shellLine: hookLine(config),
    message: "Tether now starts at login. To reconnect cmux automatically, add shellLine to your interactive shell startup file (for example ~/.zshrc)." };
}

/** Removes login startup. Running processes are left alone; `tether daemon stop` stops them. */
export async function disableStartup(config: TetherConfig, options: StartupOptions = {}) {
  const run = options.run ?? runner;
  const target = jobTarget(config);
  const unloaded = await run(["print", target]) !== 0 || await run(["bootout", target]) === 0;
  await removeAsset(jobPath(config, options.home ?? homedir()));
  await removeAsset(cmuxHookPath(config));
  return { enabled: false, unloaded };
}
