import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../src/server/config";
import { discoverDaemon, ensureDaemon } from "../src/server/lifecycle";
import { createDaemon } from "../src/server/server";

const directories: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() { const directory = await mkdtemp("/tmp/tether-auto-process-"); directories.push(directory); return resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") }); }
async function ready(config: TetherConfig) {
  for (let n = 0; n < 100; n++) { const found = await discoverDaemon(config).catch(() => null); if (found) return found; await Bun.sleep(30); }
  throw new Error("Fixture daemon did not become ready.");
}
function spawnDaemon(config: TetherConfig) {
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/server/daemon.ts")], {
    env: { PATH: process.env.PATH, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_BACKGROUND: "1" }, stdout: "ignore", stderr: "pipe",
  });
  children.push(child);
  return child;
}

test.each(["SIGTERM", "SIGINT", "SIGKILL"] as const)("a daemon ended by %s never blocks the next start", async signal => {
  const config = await fixture();
  const first = spawnDaemon(config);
  expect((await ready(config)).pid).toBe(first.pid);
  first.kill(signal); await first.exited;
  if (signal !== "SIGKILL") {
    expect(first.exitCode).toBe(0);
    expect(await Bun.file(config.discoveryPath).exists()).toBe(false);
  }
  const second = spawnDaemon(config);
  expect((await ready(config)).pid).toBe(second.pid);
}, 10_000);

test("background starts are requested through the daemon environment", async () => {
  const config = await fixture();
  let seen: NodeJS.ProcessEnv | undefined;
  await expect(ensureDaemon({ config, background: true, spawn: (_command, env) => { seen = env; }, waitAttempts: 1 })).rejects.toThrow();
  expect(seen?.TETHER_BACKGROUND).toBe("1");
});

test("cancelling a start kills and reaps the child before releasing exclusion", async () => {
  const config = await fixture();
  const pidFile = join(config.runtimeDir, "..", "test-child.pid");
  const script = `await Bun.write(process.argv[1], String(process.pid)); await Bun.sleep(60000);`;
  const abort = new AbortController();
  const startup = ensureDaemon({ config, signal: abort.signal, command: [process.execPath, "--no-env-file", "-e", script, pidFile] });
  const settled = startup.then(() => null, cause => cause as Error);
  for (let n = 0; n < 100 && !await Bun.file(pidFile).exists(); n++) await Bun.sleep(20);
  const pid = Number(await readFile(pidFile, "utf8"));
  abort.abort();
  expect(await settled).toBeInstanceOf(Error);
  expect(() => process.kill(pid, 0)).toThrow();
}, 5000);

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

test("a start request reuses a running daemon", async () => {
  const config = await fixture();
  const daemon = createDaemon({ config, web: () => new Response("reader") });
  try {
    await daemon.ready;
    let spawned = false;
    const found = await ensureDaemon({ config, background: true, spawn: () => { spawned = true; } });
    expect(found.pid).toBe(process.pid);
    expect(spawned).toBe(false);
  } finally { await daemon.stop(); }
});
