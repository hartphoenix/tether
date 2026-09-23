import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { disableAutomation, readAutomation } from "../src/server/automation-state";
import { enableStartup, disableStartup, startupStatus } from "../src/cli/startup";
import { resolveConfig } from "../src/server/config";
import { runtimeFingerprint, startupGuard, startupLabel } from "../src/server/startup-assets";

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const directory = await realpath(await mkdtemp("/tmp/tether-startup-assets-")); directories.push(directory);
  const root = join(directory, "install/releases/one"), home = join(directory, "home");
  await mkdir(join(root, "runtime"), { recursive: true }); await mkdir(join(root, "lib"));
  for (const file of ["runtime/bun", "mdreview", "tether", "lib/login.js", "lib/daemon.js", "lib/cli.js", "lib/cmux-bridge.js"]) await writeFile(join(root, file), "fixture\n", { mode: 0o700 });
  await writeFile(join(root, "release.json"), JSON.stringify({ platform: "darwin", version: "0.1.1" }));
  await symlink(root, join(directory, "install/current"));
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  return { directory, root, home, config };
}

test("stop during registration wins and the new job is unloaded", async () => {
  const f = await fixture(), commands: string[][] = [];
  await expect(enableStartup(f.config, { root: f.root, home: f.home, run: async args => {
    commands.push(args);
    if (args[0] === "print") return 1;
    if (args[0] === "bootstrap") await disableAutomation(f.config);
    return 0;
  } })).rejects.toThrow("cancelled");
  expect((await readAutomation(f.config)).enabled).toBe(false);
  expect(commands.at(-1)?.[0]).toBe("bootout");
});

test("stop during asset preparation prevents registration", async () => {
  const f = await fixture(); let bootstraps = 0;
  await expect(enableStartup(f.config, { root: f.root, home: f.home, run: async args => {
    if (args[0] === "print") { await disableAutomation(f.config); return 1; }
    if (args[0] === "bootstrap") bootstraps++;
    return 0;
  } })).rejects.toThrow("cancelled");
  expect(bootstraps).toBe(0); expect((await readAutomation(f.config)).enabled).toBe(false);
});

test("changing current invalidates pinned startup for every profile", async () => {
  const f = await fixture(); await runtimeFingerprint(f.root);
  const other = join(f.directory, "install/releases/two"); await mkdir(other);
  await unlink(join(f.directory, "install/current")); await symlink(other, join(f.directory, "install/current"));
  await expect(runtimeFingerprint(f.root)).rejects.toThrow("installation changed");
});

test("a broken executable runs once across repeated guard invocations", async () => {
  const f = await fixture(); await mkdir(f.config.configDir, { mode: 0o700 });
  await writeFile(join(f.config.configDir, "automation.json"), "{}");
  const count = join(f.directory, "count");
  await writeFile(join(f.root, "runtime/bun"), `#!/bin/sh\necho attempt >> '${count}'\nexit 1\n`, { mode: 0o700 });
  const guard = join(f.directory, "guard.sh"); await writeFile(guard, startupGuard(f.config, f.root));
  for (let boot = 0; boot < 3; boot++) await Bun.spawn(["/bin/sh", guard], { stdout: "ignore", stderr: "ignore" }).exited;
  expect(await readFile(count, "utf8")).toBe("attempt\n");
  expect((await lstat(join(f.config.configDir, "login-attempt"))).isDirectory()).toBe(true);
});

test("disable preserves modified startup assets and reports host job cleanup failure", async () => {
  const f = await fixture();
  const plist = join(f.home, "Library/LaunchAgents", `${startupLabel(f.config)}.plist`);
  await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(plist, "user-owned content");
  const result = await disableStartup(f.config, { home: f.home, run: async args => args[0] === "print" ? 0 : 1 });
  expect(result).toMatchObject({ enabled: false, unloaded: false, preserved: true });
  expect(await readFile(plist, "utf8")).toBe("user-owned content");
});

test("status exposes pre-import attachment failures without starting Tether", async () => {
  const f = await fixture(); await mkdir(f.config.configDir, { mode: 0o700 }); await mkdir(join(f.config.configDir, "attach-attempt"));
  const status = await startupStatus(f.config, { home: f.home, run: async () => 1 });
  expect(status).toMatchObject({ blocked: true, markers: { attach: true }, daemon: { running: false } });
  expect(await Bun.file(join(f.config.configDir, "tether.sqlite")).exists()).toBe(false);
});
