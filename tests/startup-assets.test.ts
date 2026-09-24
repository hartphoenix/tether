import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enableStartup, disableStartup, startupStatus } from "../src/cli/startup";
import { resolveConfig } from "../src/server/config";
import { cmuxStartupHook, startupLabel } from "../src/server/startup-assets";

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const directory = await realpath(await mkdtemp("/tmp/tether-startup-assets-")); directories.push(directory);
  const root = join(directory, "install/releases/one"), home = join(directory, "home");
  await mkdir(join(root, "runtime"), { recursive: true }); await mkdir(join(root, "lib"));
  await symlink(root, join(directory, "install/current"));
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  return { directory, root, home, config, plist: join(home, "Library/LaunchAgents", `${startupLabel(config)}.plist`) };
}

test("enable writes a job that follows the current release, and a shell hook", async () => {
  const f = await fixture(), commands: string[][] = [];
  const result = await enableStartup(f.config, { root: f.root, home: f.home, run: async args => { commands.push(args); return args[0] === "print" ? 1 : 0; } });
  const plist = await readFile(result.plist, "utf8");
  expect(plist).toContain(join(f.directory, "install/current/lib/login.js"));
  expect(plist).not.toContain(f.root);
  expect(plist).not.toContain("KeepAlive");
  expect(await readFile(result.hook, "utf8")).toContain("cmux attach");
  expect(result.shellLine).toContain(result.hook);
  expect(commands.at(-1)?.[0]).toBe("bootstrap");
});

test("enabling again replaces the loaded job instead of failing", async () => {
  const f = await fixture(), commands: string[][] = [];
  const run = async (args: string[]) => { commands.push(args); return 0; };
  await enableStartup(f.config, { root: f.root, home: f.home, run });
  await enableStartup(f.config, { root: f.root, home: f.home, run });
  expect(commands.map(args => args[0])).toEqual(["print", "bootout", "bootstrap", "print", "bootout", "bootstrap"]);
});

test("disable unloads the job and removes the plist and hook", async () => {
  const f = await fixture();
  const enabled = await enableStartup(f.config, { root: f.root, home: f.home, run: async () => 0 });
  const result = await disableStartup(f.config, { home: f.home, run: async () => 0 });
  expect(result).toEqual({ enabled: false, unloaded: true });
  expect(await Bun.file(enabled.plist).exists()).toBe(false);
  expect(await Bun.file(enabled.hook).exists()).toBe(false);
});

test("disable reports a job it could not unload", async () => {
  const f = await fixture();
  const result = await disableStartup(f.config, { home: f.home, run: async args => args[0] === "print" ? 0 : 1 });
  expect(result.unloaded).toBe(false);
});

test("status reads state without starting Tether", async () => {
  const f = await fixture(); await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(f.plist, "job");
  const status = await startupStatus(f.config, { home: f.home, run: async () => 1 });
  expect(status).toMatchObject({ enabled: true, loaded: false, daemon: { running: false }, cmux: { attached: false } });
  expect(await Bun.file(join(f.config.configDir, "tether.sqlite")).exists()).toBe(false);
});

test("the hook runs only in cmux shells and passes no stored credentials", async () => {
  const f = await fixture();
  const log = join(f.directory, "calls");
  const mdreview = join(f.root, "mdreview");
  await writeFile(mdreview, `#!/bin/sh\necho "$@ $CMUX_SOCKET_PATH" >> '${log}'\n`, { mode: 0o700 });
  const hook = join(f.directory, "hook.sh");
  await writeFile(hook, cmuxStartupHook(f.config, join(f.directory, "install")));
  expect(await readFile(hook, "utf8")).not.toContain("CAPABILITY=");
  await Bun.spawn(["/bin/sh", "-c", `. '${hook}'`], { env: { PATH: "/usr/bin:/bin" } }).exited;
  await Bun.spawn(["/bin/sh", "-c", `. '${hook}'`], { env: { PATH: "/usr/bin:/bin", CMUX_SOCKET_PATH: "/sock", CMUX_SOCKET_CAPABILITY: "cap" } }).exited;
  for (let n = 0; n < 50 && !await Bun.file(log).exists(); n++) await Bun.sleep(20);
  expect(await readFile(log, "utf8")).toBe("cmux attach /sock\n");
});

test("status explains an enabled job that macOS did not load", async () => {
  const f = await fixture(); await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(f.plist, "job");
  const status = await startupStatus(f.config, { home: f.home, run: async () => 1 });
  expect(status.issue?.code).toBe("login_job_not_loaded");
  expect(status.issue?.message).toContain("Allow in the Background");
});
