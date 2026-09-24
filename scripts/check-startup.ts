// Exercise the packaged login entry without registering a real launchd job.
import { cp, mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { enableStartup, disableStartup } from "../src/cli/startup";
import { resolveConfig } from "../src/server/config";
import { discoverDaemon } from "../src/server/lifecycle";

if (!process.argv[2]) throw new Error("Usage: bun scripts/check-startup.ts <candidate/app>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "tether-startup-check-")));
const root = join(directory, "installation/releases/test");
await mkdir(join(directory, "installation/releases"), { recursive: true });
await cp(resolve(process.argv[2]), root, { recursive: true });
await symlink(root, join(directory, "installation/current"));
const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
const options = { root, home: join(directory, "home"), run: async (args: string[]) => args[0] === "print" ? 1 : 0 };
const current = join(directory, "installation/current");
const env = { HOME: options.home, PATH: "/usr/bin:/bin", TETHER_PROFILE: config.profile, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir };
let child: Bun.Subprocess | undefined;

/** Same command and environment the generated plist gives launchd. */
function login() {
  return Bun.spawn([join(current, "runtime/bun"), "--no-env-file", join(current, "lib/login.js")], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
}
async function launch() {
  child = login();
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(`Packaged login exited early: ${await new Response(child.stderr as ReadableStream<Uint8Array>).text()}`);
    const daemon = await discoverDaemon(config).catch(() => null);
    if (daemon) {
      if (daemon.pid !== child.pid) throw new Error("Login spawned an unexpected daemon owner.");
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("Packaged login did not publish before deadline.");
}
try {
  const enabled = await enableStartup(config, options);
  if (!(await readFile(enabled.plist, "utf8")).includes(join(current, "lib/login.js"))) throw new Error("The login job does not follow the current release.");
  await launch();
  const second = login();
  if (await second.exited !== 0 || (await discoverDaemon(config))?.pid !== child!.pid) throw new Error("A second login start did not reuse the running daemon.");
  child!.kill("SIGTERM"); await child!.exited;
  if (child!.exitCode !== 0 || await discoverDaemon(config)) throw new Error("Logout (SIGTERM) did not stop the daemon cleanly.");
  await launch();
  child!.kill("SIGKILL"); await child!.exited;
  await launch();
  child!.kill("SIGTERM"); await child!.exited;
  const disabled = await disableStartup(config, options);
  if (!disabled.unloaded || await Bun.file(enabled.plist).exists() || await Bun.file(enabled.hook).exists()) throw new Error("Packaged startup cleanup failed.");
  console.log(`Packaged login start, reuse, clean logout, restart after a crash, and disable passed without launchd registration. Evidence: ${directory}`);
} finally {
  if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  await disableStartup(config, options);
}
