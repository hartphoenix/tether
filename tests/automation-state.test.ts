import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beginAttempt, claimAttempt, completeAttempt, disableAutomation, enableAutomation, readAutomation, transferAttempt } from "../src/server/automation-state";
import { resolveConfig } from "../src/server/config";
import { startupGuard, startupPlist, cmuxStartupHook } from "../src/server/startup-assets";
import { enableStartup } from "../src/cli/startup";

const directories: string[] = [];
const runtime = { root: "/immutable/package", digest: "a".repeat(64) };
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() { const directory = await mkdtemp("/tmp/tether-automation-"); directories.push(directory); return resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") }); }

test("unfinished attempts survive repeated boots and explicit enable is required", async () => {
  const config = await fixture(); expect((await readAutomation(config)).enabled).toBe(false);
  await enableAutomation(config, runtime); const attempt = await beginAttempt(config, "daemon", runtime);
  for (let boot = 0; boot < 3; boot++) {
    expect((await readAutomation(config)).daemon).toEqual(attempt);
    await expect(beginAttempt(config, "daemon", runtime)).rejects.toThrow("unfinished attempt");
  }
  await enableAutomation(config, runtime);
  expect((await beginAttempt(config, "daemon", runtime)).id).not.toBe(attempt.id);
});

test("old completion cannot clear a successor or undo disable", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const first = await beginAttempt(config, "daemon", runtime);
  const next = await transferAttempt(config, first);
  await completeAttempt(config, first);
  expect((await readAutomation(config)).daemon?.id).toBe(next.id);
  await claimAttempt(config, next);
  await disableAutomation(config);
  const stopped = await readAutomation(config);
  await completeAttempt(config, next);
  expect(await readAutomation(config)).toEqual(stopped);
  await expect(claimAttempt(config, next)).rejects.toThrow("cancelled");
});

test("concurrent daemon and bridge cleanup serialize without false failure", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const [daemon, bridge] = await Promise.all([beginAttempt(config, "daemon", runtime), beginAttempt(config, "bridge", runtime)]);
  await Promise.all([completeAttempt(config, daemon), completeAttempt(config, bridge)]);
  expect(await readAutomation(config)).toMatchObject({ enabled: true });
  expect((await readAutomation(config)).daemon).toBeUndefined(); expect((await readAutomation(config)).bridge).toBeUndefined();
});

test("nested update suppression preserves generation but user stop invalidates it", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  await disableAutomation(config);
  const generation = (await readAutomation(config)).generation;
  await disableAutomation(config, true);
  expect((await readAutomation(config)).generation).toBe(generation);
  await disableAutomation(config);
  expect((await readAutomation(config)).generation).not.toBe(generation);
});

test("corrupt state denies automation but emergency disable still works", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  await writeFile(join(config.configDir, "automation.json"), "broken");
  await expect(readAutomation(config)).rejects.toThrow();
  await disableAutomation(config);
  expect((await readAutomation(config)).enabled).toBe(false);
  expect(await readFile(join(config.configDir, "startup-disabled"), "utf8")).toBe("disabled\n");
});

test("startup assets cannot respawn and pin profile paths without shell interpolation", async () => {
  const config = await fixture();
  const plist = startupPlist(config);
  expect(plist).toContain("RunAtLoad");
  for (const key of ["KeepAlive", "StartInterval", "WatchPaths", "StartCalendarInterval"]) expect(plist).not.toContain(key);
  const guard = startupGuard(config, "/package/with spaces");
  expect(guard.indexOf("/bin/mkdir")).toBeLessThan(guard.indexOf("exec /usr/bin/env"));
  expect(guard).toContain("startup-disabled");
  expect(guard).toContain("'" + config.profile + "'");
  expect(cmuxStartupHook(config, "/package")).toContain("attach-attempt");
  await expect(enableStartup(config)).rejects.toThrow("packaged installation");
});
