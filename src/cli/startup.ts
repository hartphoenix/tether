import { lstat, mkdir, readFile, rename, unlink, writeFile, rm, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { cmuxHookPath, cmuxStartupHook, startupLabel, startupLogPath, startupPlist, startupApp, managedStartupLabel } from "../server/startup-assets";
import { statusDaemon } from "../server/lifecycle";
import { cmuxBridgeStatus } from "../hosts/cmux-bridge";
import { resolveConfig, type TetherConfig } from "../server/config";

import { fileInfo, inspectLegacy, prepareServiceApp, registerService, serviceCommand, serviceControl, lsregister, type ServiceCommand } from "../server/macos-service";
export type StartupOptions = { home?: string; root?: string; command?: ServiceCommand };
const jobPath = (config: TetherConfig, home: string) => join(home, "Library/LaunchAgents", `${startupLabel(config)}.plist`);
const jobTarget = (config: TetherConfig) => `gui/${process.getuid!()}/${managedStartupLabel(config)}`;
const hookLine = (config: TetherConfig) => `[ -r '${cmuxHookPath(config).replaceAll("'", "'\\''")}' ] && . '${cmuxHookPath(config).replaceAll("'", "'\\''")}'`;
const exists = (path: string) => lstat(path).then(() => true, cause => { if (cause.code === "ENOENT") return false; throw cause; });

export async function startupStatus(config: TetherConfig, options: StartupOptions = {}) {
  const command = options.command ?? serviceCommand;
  const app = startupApp(config), label = managedStartupLabel(config);
  const hasApp = !!await fileInfo(app);
  const registration = hasApp ? await serviceControl(app, label, "status", command) : 0;
  const legacy = await exists(jobPath(config, options.home ?? homedir()));
  const managed = hasApp && (registration === 1 || registration === 2 || !legacy);
  const plist = managed ? join(app, "Contents/Library/LaunchAgents", `${label}.plist`) : jobPath(config, options.home ?? homedir());
  const enabled = managed ? registration === 1 || registration === 2 : await exists(plist);
  const loaded = (await command(["/bin/launchctl", "print", managed ? jobTarget(config) : `gui/${process.getuid!()}/${startupLabel(config)}`])).code === 0;
  const [daemon, cmux] = await Promise.all([statusDaemon(config), cmuxBridgeStatus(config)]);
  // If the Tether background item is disabled, launchd may skip the login job.
  const issue = enabled && !loaded ? { code: "login_job_not_loaded", message: "Login startup is enabled but macOS did not load it. In System Settings > General > Login Items & Extensions > Allow in the Background, turn on \"tether\", then run `tether startup enable`." } : undefined;
  return { enabled, loaded, registration, ...(issue ? { issue } : {}), plist, log: startupLogPath(config), hook: cmuxHookPath(config), hookInstalled: await exists(cmuxHookPath(config)), shellLine: hookLine(config),
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

/** App-owned registration; repeated setup preserves macOS consent and the stable bundle. */
export async function enableStartup(config: TetherConfig, options: StartupOptions = {}) {
  if (process.platform !== "darwin") throw new Error("Login startup requires macOS 13 or newer.");
  const root = options.root ?? process.env.TETHER_INSTALL_ROOT;
  if (!root) throw new Error("Login startup requires a packaged installation; source checkouts are not registered.");
  const installBase = dirname(dirname(root));
  const command = options.command ?? serviceCommand;
  const app = startupApp(config), label = managedStartupLabel(config);
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  await prepareServiceApp(app, join(root, "tether.app"), startupLabel(config), label, startupPlist(config, installBase), command);
  const registration = await registerService(app, label, { path: jobPath(config, options.home ?? homedir()), label: startupLabel(config), ownedPath: installBase }, command);
  await writeAsset(cmuxHookPath(config), cmuxStartupHook(config, installBase));
  return { enabled: registration.status === 1 || registration.status === 2, registration: registration.status,
    plist: join(app, "Contents/Library/LaunchAgents", `${label}.plist`), hook: cmuxHookPath(config), shellLine: hookLine(config),
    message: registration.legacyDisabled ? "Legacy startup is disabled in macOS and was preserved. Allow it in Login Items before migrating."
      : registration.status === 2 ? "Allow tether in System Settings > General > Login Items & Extensions > Allow in the Background."
      : "Tether now starts at login. To reconnect cmux automatically, add shellLine to your interactive shell startup file." };
}

/** Unregister before removing the app; failed unloads preserve all recovery assets. */
export async function disableStartup(config: TetherConfig, options: StartupOptions = {}) {
  const command = options.command ?? serviceCommand;
  const app = startupApp(config), label = managedStartupLabel(config);
  if (await fileInfo(app)) {
    await serviceControl(app, label, "unregister", command);
    await command([lsregister, "-u", app]);
    await rm(app, { recursive: true });
  }
  const path = jobPath(config, options.home ?? homedir());
  if (await fileInfo(path)) {
    const root = options.root ?? process.env.TETHER_INSTALL_ROOT;
    if (!root) throw new Error("The installation root is required to verify legacy startup ownership.");
    const old = await inspectLegacy({ path, label: startupLabel(config), ownedPath: dirname(dirname(root)) }, command);
    if (old?.loaded && (await command(["/bin/launchctl", "bootout", `gui/${process.getuid!()}/${startupLabel(config)}`])).code) return { enabled: true, unloaded: false };
    await removeAsset(path);
  }
  await removeAsset(cmuxHookPath(config));
  return { enabled: false, unloaded: true };
}

/** Brings an installed hook up to the running release's version. Only an
 * existing hook is rewritten; removing it remains the way to opt out. */
export async function refreshCmuxHook(config: TetherConfig, root = process.env.TETHER_INSTALL_ROOT): Promise<boolean> {
  if (!root) return false;
  const path = cmuxHookPath(config);
  const current = await readFile(path, "utf8").catch(() => null);
  const next = cmuxStartupHook(config, dirname(dirname(root)));
  if (current === null || current === next) return false;
  await writeAsset(path, next);
  return true;
}

/** Installer upgrade hook: never enables startup on a fresh or explicitly disabled installation. */
export async function migrateStartup(config: TetherConfig, options: StartupOptions = {}) {
  if (!await fileInfo(jobPath(config, options.home ?? homedir()))) return { migrated: false };
  const result = await enableStartup(config, options);
  return { migrated: result.enabled, message: result.message };
}

/** Upgrade every packaged profile belonging to this installation, without touching other apps. */
export async function migrateInstalledStartups(options: StartupOptions = {}) {
  const root = options.root ?? process.env.TETHER_INSTALL_ROOT;
  if (!root) throw new Error("Startup migration requires an installation root.");
  const command = options.command ?? serviceCommand;
  const directory = join(options.home ?? homedir(), "Library/LaunchAgents");
  const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const results = [];
  for (const name of names) {
    if (!/^local\.tether\..+\.plist$/.test(name)) continue;
    const path = join(directory, name), info = await fileInfo(path);
    if (!info?.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) continue;
    const parsed = await command(["/usr/bin/plutil", "-convert", "json", "-o", "-", path]);
    if (parsed.code) continue;
    const plist = JSON.parse(parsed.stdout);
    const owned = join(dirname(dirname(root)), "current");
    if (!Array.isArray(plist.ProgramArguments) || !plist.ProgramArguments.some((arg: unknown) => typeof arg === "string" && arg.startsWith(`${owned}/`))) continue;
    const env = plist.EnvironmentVariables;
    if (!env || typeof env.TETHER_PROFILE !== "string" || ![env.TETHER_CONFIG_DIR, env.TETHER_RUNTIME_DIR].every(value => typeof value === "string" && isAbsolute(value))) throw new Error(`Incomplete legacy profile configuration: ${path}`);
    const config = resolveConfig({ profile: env.TETHER_PROFILE, configDir: env.TETHER_CONFIG_DIR, runtimeDir: env.TETHER_RUNTIME_DIR });
    if (name !== `${startupLabel(config)}.plist` || plist.Label !== startupLabel(config)) throw new Error(`Legacy profile identity mismatch: ${path}`);
    results.push({ profile: config.profile, ...await migrateStartup(config, options) });
  }
  return results;
}
