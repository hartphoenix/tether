import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enableStartup, disableStartup, startupStatus, migrateStartup, migrateInstalledStartups } from "../src/cli/startup";
import { resolveConfig } from "../src/server/config";
import { cmuxStartupHook, startupLabel, startupApp, managedStartupLabel } from "../src/server/startup-assets";

import { serviceCommand, type ServiceCommand } from "../src/server/macos-service";
const directories: string[] = [];
function mockService() {
  let status = 0;
  const calls: string[][] = [];
  const command: ServiceCommand = async args => {
    calls.push(args);
    if (args[0] === "/usr/bin/plutil") return serviceCommand(args);
    if (args[1] === "--service") {
      if (args[3] === "register") status = 1;
      if (args[3] === "unregister") status = 0;
      return { code: 0, stdout: String(status), stderr: "" };
    }
    return { code: args[1] === "print" ? 1 : 0, stdout: "", stderr: "" };
  };
  return { command, calls, setStatus: (value: number) => { status = value; } };
}
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const directory = await realpath(await mkdtemp("/tmp/tether-startup-assets-")); directories.push(directory);
  const root = join(directory, "install/releases/one"), home = join(directory, "home");
  await mkdir(join(root, "runtime"), { recursive: true }); await mkdir(join(root, "lib"));
  await mkdir(join(root, "tether.app/Contents/Frameworks"), { recursive: true });
  await mkdir(join(root, "tether.app/Contents/Resources"));
  await writeFile(join(root, "tether.app/Contents/Frameworks/tether-service"), "native fixture");
  await writeFile(join(root, "tether.app/Contents/Resources/tether.icns"), "icon fixture");
  await symlink(root, join(directory, "install/current"));
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  return { directory, root, home, config, plist: join(home, "Library/LaunchAgents", `${startupLabel(config)}.plist`) };
}

test.skipIf(process.platform !== "darwin")("enable embeds an app-owned job following current and never writes a legacy LaunchAgent", async () => {
  const f = await fixture(), mock = mockService();
  const result = await enableStartup(f.config, { root: f.root, home: f.home, command: mock.command });
  const plist = await readFile(result.plist, "utf8");
  expect(plist).toContain(join(f.directory, "install/current/lib/login.js"));
  expect(plist).toContain("<key>BundleProgram</key><string>Contents/MacOS/tether</string>");
  expect(plist).not.toContain("AssociatedBundleIdentifiers");
  expect(plist).not.toContain(f.root);
  expect(plist).not.toContain("KeepAlive");
  expect(await Bun.file(f.plist).exists()).toBe(false);
  expect(await readFile(result.hook, "utf8")).toContain("cmux attach");
  expect(mock.calls.some(args => args.includes("bootstrap"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("repeat setup neither re-registers nor resets denied consent", async () => {
  const f = await fixture(), mock = mockService();
  const options = { root: f.root, home: f.home, command: mock.command };
  await enableStartup(f.config, options);
  await enableStartup(f.config, options);
  mock.setStatus(2);
  const denied = await enableStartup(f.config, options);
  expect(denied.registration).toBe(2);
  expect(denied.message).toContain("Allow tether");
  expect(mock.calls.filter(args => args[3] === "register")).toHaveLength(1);
  expect(mock.calls.filter(args => args[3] === "unregister")).toHaveLength(0);
});

test.skipIf(process.platform !== "darwin")("disable unregisters before removing app and hook", async () => {
  const f = await fixture(), mock = mockService();
  const options = { root: f.root, home: f.home, command: mock.command };
  const enabled = await enableStartup(f.config, options);
  const result = await disableStartup(f.config, options);
  expect(result).toEqual({ enabled: false, unloaded: true });
  expect(await Bun.file(enabled.plist).exists()).toBe(false);
  expect(await Bun.file(enabled.hook).exists()).toBe(false);
  expect(mock.calls.some(args => args[3] === "unregister")).toBe(true);
});

test.skipIf(process.platform !== "darwin")("failed unregister preserves the service app and hook", async () => {
  const f = await fixture(), mock = mockService();
  const options = { root: f.root, home: f.home, command: mock.command };
  const enabled = await enableStartup(f.config, options);
  await expect(disableStartup(f.config, { ...options, command: async args => args[3] === "unregister" ? { code: 1, stdout: "", stderr: "denied" } : mock.command(args) })).rejects.toThrow("denied");
  expect(await Bun.file(enabled.plist).exists()).toBe(true);
  expect(await Bun.file(enabled.hook).exists()).toBe(true);
});

test("status reads state without starting Tether", async () => {
  const f = await fixture();
  const status = await startupStatus(f.config, { home: f.home, command: mockService().command });
  expect(status).toMatchObject({ enabled: false, loaded: false, daemon: { running: false }, cmux: { attached: false } });
  expect(await Bun.file(join(f.config.configDir, "tether.sqlite")).exists()).toBe(false);
});

async function legacy(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(f.plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${startupLabel(f.config)}</string><key>ProgramArguments</key><array><string>${f.directory}/install/current/runtime/bun</string></array><key>EnvironmentVariables</key><dict><key>TETHER_PROFILE</key><string>${f.config.profile}</string><key>TETHER_CONFIG_DIR</key><string>${f.config.configDir}</string><key>TETHER_RUNTIME_DIR</key><string>${f.config.runtimeDir}</string></dict></dict></plist>`);
}

test.skipIf(process.platform !== "darwin")("installer migrates owned legacy jobs and never enables fresh startup", async () => {
  const f = await fixture(), mock = mockService();
  const options = { root: f.root, home: f.home, command: mock.command };
  expect(await migrateStartup(f.config, options)).toEqual({ migrated: false });
  await legacy(f);
  expect((await migrateStartup(f.config, options)).migrated).toBe(true);
  expect(await Bun.file(f.plist).exists()).toBe(false);
  expect(await Bun.file(join(f.config.configDir, "startup/retired", `${startupLabel(f.config)}.plist`)).exists()).toBe(true);
});

test.skipIf(process.platform !== "darwin")("migration preserves disabled legacy jobs on repeated installer runs", async () => {
  const f = await fixture(), mock = mockService(); await legacy(f);
  const command: ServiceCommand = args => args[1] === "print-disabled" ? Promise.resolve({ code: 0, stdout: `"${startupLabel(f.config)}" => true`, stderr: "" }) : mock.command(args);
  for (let n = 0; n < 2; n++) expect((await migrateStartup(f.config, { root: f.root, home: f.home, command })).migrated).toBe(false);
  expect(await Bun.file(f.plist).exists()).toBe(true);
  expect(mock.calls.some(args => args[3] === "register")).toBe(false);
});

test.skipIf(process.platform !== "darwin")("failed registration restores the legacy plist and loaded job", async () => {
  const f = await fixture(), mock = mockService(); await legacy(f);
  const calls: string[][] = [];
  const command: ServiceCommand = async args => {
    calls.push(args);
    if (args[3] === "register") return { code: 1, stdout: "", stderr: "registration failed" };
    if (args[1] === "print") return { code: 0, stdout: "", stderr: "" };
    return mock.command(args);
  };
  await expect(migrateStartup(f.config, { root: f.root, home: f.home, command })).rejects.toThrow("registration failed");
  expect(await Bun.file(f.plist).exists()).toBe(true);
  expect(calls.some(args => args[1] === "bootout")).toBe(true);
  expect(calls.some(args => args[1] === "bootstrap" && args[3] === f.plist)).toBe(true);
});

test.skipIf(process.platform !== "darwin")("migration rejects another installation's job", async () => {
  const f = await fixture(), mock = mockService(); await legacy(f);
  await writeFile(f.plist, (await readFile(f.plist, "utf8")).replace(`${f.directory}/install/current`, "/other/installation/current"));
  await expect(migrateStartup(f.config, { root: f.root, home: f.home, command: mock.command })).rejects.toThrow("unrelated");
  expect(mock.calls.some(args => args[1] === "bootout")).toBe(false);
  expect(await Bun.file(f.plist).exists()).toBe(true);
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
  const status = await startupStatus(f.config, { home: f.home, command: mockService().command });
  expect(status.issue?.code).toBe("login_job_not_loaded");
  expect(status.issue?.message).toContain("Allow in the Background");
});

test.skipIf(!Bun.which("zsh"))("the hook reattaches at a zsh prompt once the bridge is gone, at most every 30 seconds", async () => {
  const f = await fixture();
  const log = join(f.directory, "calls");
  await writeFile(join(f.root, "mdreview"), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o700 });
  const hook = join(f.directory, "hook.sh");
  await writeFile(hook, cmuxStartupHook(f.config, join(f.directory, "install")));
  await mkdir(f.config.runtimeDir, { recursive: true });
  await writeFile(f.config.cmuxBridgePath, "{}");
  const script = `. '${hook}'; . '${hook}'; print -r -- "$precmd_functions"; _tether_cmux_check; rm '${f.config.cmuxBridgePath}'; _tether_cmux_check; SECONDS=1000; _tether_cmux_check; sleep 0.3`;
  const child = Bun.spawn([Bun.which("zsh")!, "-f", "-c", script], { env: { PATH: "/usr/bin:/bin", CMUX_SOCKET_PATH: "/sock", CMUX_SOCKET_CAPABILITY: "cap" }, stdout: "pipe" });
  expect((await new Response(child.stdout).text()).trim()).toBe("_tether_cmux_check");
  await child.exited;
  // Two sourced startups, then one prompt-time retry after the bridge vanished.
  expect(await readFile(log, "utf8")).toBe("cmux attach\ncmux attach\ncmux attach\n");
});

test("attach refreshes an outdated installed hook and never creates one", async () => {
  const f = await fixture();
  const { refreshCmuxHook } = await import("../src/cli/startup");
  expect(await refreshCmuxHook(f.config, f.root)).toBe(false);
  await mkdir(f.config.configDir, { recursive: true });
  await writeFile(join(f.config.configDir, "cmux-startup.sh"), "# old hook\n");
  expect(await refreshCmuxHook(f.config, f.root)).toBe(true);
  expect(await readFile(join(f.config.configDir, "cmux-startup.sh"), "utf8")).toContain("_tether_cmux_check");
  expect(await refreshCmuxHook(f.config, f.root)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("installer discovers all owned profiles and skips another installation", async () => {
  const f = await fixture(), mock = mockService();
  await legacy(f);
  const config = resolveConfig({ profile: "second", configDir: join(f.directory, "second-config"), runtimeDir: join(f.directory, "second-runtime") });
  const second = { ...f, config, plist: join(f.home, "Library/LaunchAgents", `${startupLabel(config)}.plist`) };
  await legacy(second);
  const other = await fixture();
  const unrelated = join(f.home, "Library/LaunchAgents", `${startupLabel(other.config)}.plist`);
  await legacy(other); await writeFile(unrelated, await readFile(other.plist));
  const results = await migrateInstalledStartups({ root: f.root, home: f.home, command: mock.command });
  expect(results).toHaveLength(2);
  expect(results.every(result => result.migrated)).toBe(true);
  expect(await Bun.file(unrelated).exists()).toBe(true);
});
