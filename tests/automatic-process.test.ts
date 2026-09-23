import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { automationTransaction, ownsAttempt, beginAttempt, disableAutomation, enableAutomation, readAutomation } from "../src/server/automation-state";
import { acquireStartupLock, prepareConfig, resolveConfig, type TetherConfig } from "../src/server/config";
import { discoverDaemon, ensureAutomaticDaemon, ensureDaemon, stopDaemon } from "../src/server/lifecycle";
import { createDaemon } from "../src/server/server";

const directories: string[] = [], children: Bun.Subprocess[] = [];
const runtime = { root: "/test-runtime", digest: "b".repeat(64) };
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() { const directory = await mkdtemp("/tmp/tether-auto-process-"); directories.push(directory); return resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") }); }
async function ready(config: TetherConfig) {
  for (let n = 0; n < 100; n++) { const found = await discoverDaemon(config).catch(() => null); if (found) return found; await Bun.sleep(30); }
  throw new Error("Fixture daemon did not become ready.");
}

test.each(["SIGTERM", "SIGINT", "SIGKILL"] as const)("automatic process %s preserves the intended next-login state", async signal => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const attempt = await beginAttempt(config, "daemon", runtime);
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/server/daemon.ts")], {
    env: { PATH: process.env.PATH, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_AUTOMATION_ATTEMPT: JSON.stringify(attempt) }, stdout: "ignore", stderr: "pipe",
  }); children.push(child);
  const daemon = await ready(config); expect(daemon.pid).toBe(child.pid);
  expect((await readAutomation(config)).daemon?.pid).toBe(child.pid);
  child.kill(signal); await child.exited;
  const state = await readAutomation(config);
  expect(state.enabled).toBe(true);
  if (signal === "SIGKILL") {
    expect(state.daemon?.id).toBe(attempt.id);
    await expect(beginAttempt(config, "daemon", runtime)).rejects.toThrow("unfinished attempt");
  } else { expect(state.daemon).toBeUndefined(); expect(child.exitCode).toBe(0); }
}, 10_000);

test("stop intent prevents a reserved successor from spawning", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const generation = (await readAutomation(config)).generation;
  await disableAutomation(config);
  let spawned = false;
  await expect(ensureDaemon({ config, generation, spawn: () => { spawned = true; }, waitAttempts: 1 })).rejects.toThrow("cancelled");
  expect(spawned).toBe(false);
});

test("stop while an owned child starts kills and reaps it before releasing exclusion", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const attempt = await beginAttempt(config, "daemon", runtime);
  const pidFile = join(config.configDir, "test-child.pid");
  const script = `await Bun.write(process.argv[1], String(process.pid)); await Bun.sleep(60000);`;
  const startup = ensureDaemon({ config, generation: attempt.generation, attempt, command: [process.execPath, "--no-env-file", "-e", script, pidFile] });
  const settled = startup.then(() => null, cause => cause as Error);
  for (let n = 0; n < 100 && !await Bun.file(pidFile).exists(); n++) await Bun.sleep(20);
  const pid = Number(await readFile(pidFile, "utf8"));
  await disableAutomation(config);
  expect((await settled)?.message).toContain("cancelled");
  expect(() => process.kill(pid, 0)).toThrow();
}, 5000);

test("stop after claim but before publication cannot expose a late daemon", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const attempt = await beginAttempt(config, "daemon", runtime);
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const daemon = createDaemon({ config, web: () => new Response("reader"), publishStartup: async publish => {
    entered(); await barrier;
    await automationTransaction(config, async state => { if (!ownsAttempt(state, attempt)) throw new Error("cancelled"); await publish(); });
  } });
  const readiness = daemon.ready.catch(cause => cause as Error);
  await started; await disableAutomation(config); release();
  expect((await readiness)?.message).toBe("cancelled");
  await daemon.stop();
  expect(await Bun.file(config.discoveryPath).exists()).toBe(false);
});

test("shutdown during initialization shares its drain and keeps SQLite open until initialization ends", async () => {
  const config = await fixture();
  const daemon = createDaemon({ config, web: () => new Response("reader") });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  daemon.service.recoverMoves = async () => { entered(); await pending; daemon.service.store.db.query("SELECT 1").get(); };
  await started;
  const first = daemon.stop(), second = daemon.stop();
  expect(first).toBe(second);
  let closed = false; void first.then(() => { closed = true; });
  await Bun.sleep(20); expect(closed).toBe(false);
  release(); await first;
  expect(closed).toBe(true);
});

test("a concurrent manual daemon releases an unused automatic reservation without adoption", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const attempt = await beginAttempt(config, "daemon", runtime);
  // An unclaimed reservation belongs to a launcher, never to the winner.
  await automationTransaction(config, async (state, save) => { await save({ ...state, daemon: { ...attempt, pid: process.pid + 100000 } }); });
  const daemon = createDaemon({ config, web: () => new Response("reader") });
  try {
    await daemon.ready;
    const winner = await ensureDaemon({ config, attempt, generation: attempt.generation });
    expect(winner.pid).toBe(process.pid);
    expect((await readAutomation(config)).daemon).toBeUndefined();
    expect((await readAutomation(config)).enabled).toBe(true);
  } finally { await daemon.stop(); }
});

test("cmux attachment joins an in-flight login attempt without replacing it", async () => {
  const config = await fixture(); await enableAutomation(config, runtime);
  const attempt = await beginAttempt(config, "daemon", runtime);
  const joined = ensureAutomaticDaemon(config, runtime);
  const daemon = createDaemon({ config, web: () => new Response("reader") });
  try {
    await daemon.ready;
    expect((await joined).pid).toBe(process.pid);
    expect((await readAutomation(config)).daemon?.id).toBe(attempt.id);
  } finally { await daemon.stop(); }
});

test("attachment reacquires exclusion when a login owner exits before reserving", async () => {
  const config = await fixture(); await prepareConfig(config); await enableAutomation(config, runtime);
  // Model login's barrier after acquiring startup exclusion but before reserve.
  const loginLock = await acquireStartupLock(config);
  const joining = ensureAutomaticDaemon(config, runtime);
  const settled = joining.then(value => value, cause => { throw cause; });
  try {
    for (let n = 0; n < 100 && !(await readAutomation(config)).daemon; n++) await Bun.sleep(10);
    expect((await readAutomation(config)).daemon).toBeDefined();
    await expect(beginAttempt(config, "daemon", runtime)).rejects.toThrow("unfinished attempt");
    await loginLock.release();
    const winner = await settled;
    expect(winner.pid).not.toBe(process.pid);
    expect((await readAutomation(config)).daemon?.pid).toBe(winner.pid);
  } finally {
    await loginLock.release().catch(() => {});
    await stopDaemon(config);
    for (let n = 0; n < 100 && await discoverDaemon(config).catch(() => null); n++) await Bun.sleep(20);
  }
}, 5000);
