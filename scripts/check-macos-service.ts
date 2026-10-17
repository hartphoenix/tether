/** Opt-in native acceptance: creates and removes one isolated login service. */
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir, userInfo } from "node:os";
import { installHeadless, headlessAssets } from "./install-headless";
import { resolveConfig, readDiscovery } from "../src/server/config";
import { discoverDaemon, stopDaemon } from "../src/server/lifecycle";
import { enableStartup, disableStartup } from "../src/cli/startup";
import { startupApp, startupLabel, managedStartupLabel, startupPlist } from "../src/server/startup-assets";
import { serviceCommand, serviceControl, lsregister } from "../src/server/macos-service";
if (!process.argv[2] || process.argv[3] !== "--register-test-service") throw new Error("Usage: bun scripts/check-macos-service.ts <candidate/app> --register-test-service (registers an isolated macOS agent)");
// Real registration affects account-wide Background Items and sends OS notifications.
// Temporary profiles do not isolate those effects. Never run on a normal login account.
if (userInfo().username !== "tether-test") throw new Error("Native registration acceptance requires a disposable macOS account named tether-test. It must not run in a personal account.");
const directory = await realpath(await mkdtemp(join(tmpdir(), "tether-managed-native-")));
const root = join(directory, "installation/releases/one"), current = join(directory, "installation/current");
await mkdir(join(directory, "installation/releases"), { recursive: true });
await cp(resolve(process.argv[2]), root, { recursive: true });
await symlink(root, current);
const config = resolveConfig({ profile: `native-${crypto.randomUUID().slice(0, 8)}`, configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
const options = { root };
const label = managedStartupLabel(config), app = startupApp(config);
const legacyPath = join(homedir(), "Library/LaunchAgents", `${startupLabel(config)}.plist`);
const domain = `gui/${process.getuid!()}`;
async function ready(jobLabel = label) {
  for (let n = 0; n < 200; n++) {
    const found = await discoverDaemon(config).catch(() => null);
    if (found) {
      const job = await serviceCommand(["/bin/launchctl", "print", `${domain}/${jobLabel}`]);
      const pid = Number(job.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      if (pid === found.pid) return found;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Managed daemon did not start. Evidence: ${directory}`);
}
try {
  await mkdir(config.configDir, { recursive: true });
  // Real legacy job, scoped to this temporary profile; uses the same runtime as the upgrade.
  const legacy = startupPlist(config, join(directory, "installation"))
    .replace(`<string>${label}</string>`, `<string>${startupLabel(config)}</string>`)
    .replace("<key>BundleProgram</key><string>Contents/MacOS/tether</string>\n", "")
    .replace("<string>tether</string><string>--launch</string>", "");
  await mkdir(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  await writeFile(legacyPath, legacy, { flag: "wx", mode: 0o600 });
  const boot = await serviceCommand(["/bin/launchctl", "bootstrap", domain, legacyPath]);
  if (boot.code) throw new Error(`Legacy fixture failed: ${boot.stderr}`);
  await ready(startupLabel(config));
  const migration = Bun.spawn([join(root, "runtime/bun"), "--no-env-file", join(root, "lib/migrate-startup.js")], {
    env: { ...process.env, TETHER_INSTALL_ROOT: root }, stdout: "pipe", stderr: "pipe",
  });
  const [migrationCode, migrationOutput, migrationError] = await Promise.all([migration.exited, new Response(migration.stdout).text(), new Response(migration.stderr).text()]);
  if (migrationCode) throw new Error(`Packaged migration failed: ${migrationError}`);
  if (!migrationOutput.includes(config.profile)) throw new Error("Packaged installer did not discover the legacy profile.");
  if (await serviceControl(app, label, "status") !== 1) throw new Error("Native approval required; test has not passed.");
  const first = await ready();
  if (await Bun.file(legacyPath).exists()) throw new Error("Legacy plist still installed.");
  if ((await serviceCommand(["/bin/launchctl", "print", `${domain}/${startupLabel(config)}`])).code === 0) throw new Error("Legacy job still loaded.");
  await enableStartup(config, options);
  if ((await ready()).pid !== first.pid) throw new Error("Repeated setup restarted the daemon.");
  // Switch the release pointer, then exercise launchd restart through the stable app.
  const next = join(directory, "installation/releases/two");
  await cp(root, next, { recursive: true });
  await rm(current); await symlink(next, current);
  await stopDaemon(config);
  for (let n = 0; await readDiscovery(config); n++) {
    if (n >= 200) throw new Error("Previous daemon did not finish stopping.");
    await Bun.sleep(50);
  }
  const restarted = await serviceCommand(["/bin/launchctl", "kickstart", `${domain}/${label}`]);
  if (restarted.code) throw new Error(restarted.stderr);
  const second = await ready();
  if (second.pid === first.pid) throw new Error("Restart reused old daemon.");
  const processInfo = await serviceCommand(["/bin/ps", "-p", String(second.pid), "-o", "command="]);
  if (!processInfo.stdout.includes("current/lib/login.js")) throw new Error("Service does not follow the current release.");
  const signature = await serviceCommand(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  if (signature.code) throw new Error(signature.stderr);
  const job = await serviceCommand(["/bin/launchctl", "print", `${domain}/${label}`]);
  if (!job.stdout.includes("com.apple.xpc.ServiceManagement")) throw new Error("Job is not app-managed.");
  await writeFile(join(directory, "registration.txt"), job.stdout);
  const bin = join(directory, "bin"), home = join(directory, "home");
  await mkdir(bin); await mkdir(home);
  await writeFile(join(directory, "installation/install.json"), JSON.stringify({ binDirectory: bin }));
  for (const name of ["tether", "mdreview"]) await symlink(join(current, name), join(bin, name));
  await stopDaemon(config);
  for (let n = 0; await readDiscovery(config); n++) {
    if (n >= 200) throw new Error("Daemon did not stop before uninstall.");
    await Bun.sleep(50);
  }
  const uninstall = Bun.spawn([join(next, "runtime/bun"), "--no-env-file", join(next, "lib/cli.js"), "uninstall"], {
    env: { HOME: home, PATH: "/usr/bin:/bin", TETHER_INSTALL_ROOT: next, TETHER_PROFILE: config.profile, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir }, stdout: "pipe", stderr: "pipe",
  });
  const [uninstallCode, uninstallOut, uninstallError] = await Promise.all([uninstall.exited, new Response(uninstall.stdout).text(), new Response(uninstall.stderr).text()]);
  if (uninstallCode || !JSON.parse(uninstallOut).ok) throw new Error(`Managed uninstall failed: ${uninstallOut} ${uninstallError}`);
  if ((await serviceCommand(["/bin/launchctl", "print", `${domain}/${label}`])).code === 0) throw new Error("Disable left a loaded job.");
  const source = { role: "service" as const, platform: "darwin" as const, checkout: resolve(import.meta.dir, ".."),
    directory: join(directory, "source-service"), bun: process.execPath, profile: config.profile,
    configDirectory: config.configDir, runtimeDirectory: config.runtimeDir, supervise: true };
  const assets = headlessAssets(source);
  try {
    await installHeadless(source);
    await ready(assets.managedLabel);
    if (await Bun.file(join(homedir(), "Library/LaunchAgents", `${assets.label}.plist`)).exists()) throw new Error("Source installer created a legacy agent.");
    if (await serviceControl(assets.managedApp, assets.managedLabel, "status") !== 1) throw new Error("Source agent is not registered.");
  } finally {
    await serviceControl(assets.managedApp, assets.managedLabel, "unregister");
    await serviceCommand([lsregister, "-u", assets.managedApp]);
    await rm(assets.managedApp, { recursive: true });
  }
  console.log(`Native packaged migration, repeat setup, release switch, restart, signature, uninstall and source supervision passed. Evidence: ${directory}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await disableStartup(config, options);
  await serviceCommand(["/bin/launchctl", "bootout", `${domain}/${startupLabel(config)}`]);
  await stopDaemon(config).catch(() => {});
  await rm(legacyPath, { force: true });
}
