// Exercise the packaged login gate without registering a real launchd job.
import { cp, lstat, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { enableStartup, disableStartup, startupStatus } from "../src/cli/startup";
import { resolveConfig } from "../src/server/config";
import { discoverDaemon } from "../src/server/lifecycle";
import { readAutomation } from "../src/server/automation-state";

if (!process.argv[2]) throw new Error("Usage: bun scripts/check-startup.ts <candidate/app>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "tether-startup-check-")));
const root = join(directory, "installation/releases/test");
await mkdir(join(directory, "installation/releases"), { recursive: true });
await cp(resolve(process.argv[2]), root, { recursive: true });
await symlink(root, join(directory, "installation/current"));
const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
const options = { root, home: join(directory, "home"), run: async (args: string[]) => args[0] === "print" ? 1 : 0 };
let child: Bun.Subprocess | undefined;
async function launch() {
  child = Bun.spawn(["/bin/sh", join(config.configDir, "login-guard.sh")], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(`Packaged login exited early: ${await new Response(child.stderr as ReadableStream<Uint8Array>).text()}`);
    const daemon = await discoverDaemon(config).catch(() => null);
    if (daemon) {
      if (daemon.pid !== child.pid) throw new Error("Login spawned an unexpected daemon owner.");
      if ((await readAutomation(config)).daemon?.pid !== child.pid) throw new Error("Packaged login did not claim its attempt.");
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("Packaged login did not publish before deadline.");
}
try {
  await enableStartup(config, options);
  await launch();
  child!.kill("SIGTERM"); await child!.exited;
  if (child!.exitCode !== 0 || (await readAutomation(config)).daemon) throw new Error("Clean packaged shutdown retained its attempt.");
  if (await lstat(join(config.configDir, "login-attempt")).catch(() => null)) throw new Error("Clean packaged shutdown retained its shell latch.");
  await launch();
  child!.kill("SIGKILL"); await child!.exited;
  if (!(await startupStatus(config, options)).blocked) throw new Error("Packaged crash was not latched.");
  const retry = Bun.spawn(["/bin/sh", join(config.configDir, "login-guard.sh")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (await retry.exited !== 0 || await discoverDaemon(config)) throw new Error("A latched login retried the runtime.");
  const disabled = await disableStartup(config, options);
  if (!disabled.stopped || !disabled.unloaded || (await readAutomation(config)).enabled) throw new Error("Packaged startup cleanup failed.");
  console.log(`Packaged login, clean shutdown, crash latch, repeated-login suppression and disable passed without launchd registration. Evidence: ${directory}`);
} finally {
  if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  await disableStartup(config, options);
}
