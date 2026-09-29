import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTetherRunner, childEnvironment, TetherError } from "../integrations/paseo/server/tether-cli";
import { ProcessPool } from "../integrations/paseo/server/process-pool";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body: string) {
  const root = await mkdtemp("/tmp/tether-runner-test-"); roots.push(root);
  const binary = join(root, "command");
  await writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return { root, binary };
}
const envelope = (data: unknown) => JSON.stringify({ protocol: 1, ok: true, data });
async function until(check: () => Promise<boolean>, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error("fixture deadline"); await Bun.sleep(10); }
}

test("deadline rejects a SIGTERM-resistant child and retains capacity until forced exit", async () => {
  const { binary, root } = await fixture(`process.on('SIGTERM',()=>{}); await Bun.write(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
  const marker = join(root, "pid");
  const pool = new ProcessPool([1, 1], 2);
  const abort = new AbortController();
  const run = createTetherRunner({ binary: () => binary, profile: () => "test", pool, signal: abort.signal, timeoutMs: 2000, killGraceMs: 100 });
  const pending = run([marker]);
  const rejected = pending.catch(error => error);
  await until(async () => Bun.file(marker).exists());
  const pid = Number(await readFile(marker, "utf8"));
  abort.abort();
  expect(await rejected).toMatchObject({ code: "tether_cancelled" });
  let acquired = false;
  const slot = pool.acquire(false, new AbortController().signal).then(release => { acquired = true; release(); });
  await Bun.sleep(20);
  expect(acquired).toBe(false);
  await slot;
  expect(() => process.kill(pid, 0)).toThrow();
  const timed = createTetherRunner({ binary: () => binary, profile: () => "test", timeoutMs: 100, killGraceMs: 20 });
  await expect(timed([marker])).rejects.toMatchObject({ code: "tether_timeout" });
  await Bun.sleep(100);
});

test("queue is bounded, cancellable, and a long poll leaves interactive capacity", async () => {
  const pool = new ProcessPool([1, 1], 1);
  const controller = new AbortController();
  const releaseWait = await pool.acquire(true, controller.signal);
  const releaseInteractive = await pool.acquire(false, controller.signal);
  const queuedController = new AbortController();
  const queued = pool.acquire(false, queuedController.signal);
  const rejected = queued.catch(error => error);
  await expect(pool.acquire(true, controller.signal)).rejects.toMatchObject({ code: "tether_busy" });
  queuedController.abort(); expect(await rejected).toMatchObject({ code: "tether_cancelled" });
  releaseInteractive();
  const next = await pool.acquire(false, controller.signal);
  next(); releaseWait();
});

test("queued commands time out without spawning and release cancelled queue entries", async () => {
  const { binary, root } = await fixture(`await Bun.write(process.argv[2], 'started'); console.log('${envelope(true)}');`);
  const pool = new ProcessPool([1, 1], 1);
  const release = await pool.acquire(false, new AbortController().signal);
  const marker = join(root, "started");
  const run = createTetherRunner({ binary: () => binary, profile: () => "test", pool, timeoutMs: 30 });
  await expect(run([marker])).rejects.toMatchObject({ code: "tether_timeout" });
  release(); await Bun.sleep(20);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await createTetherRunner({ binary: () => binary, profile: () => "test", pool, timeoutMs: 2000 })([marker])).toBe(true);
});

test("stdout and stderr have independent hard bounds; valid large JSON remains intact", async () => {
  const { binary } = await fixture(`const mode=process.argv[2]; if(mode==='stderr') process.stderr.write('x'.repeat(2048)); else console.log(JSON.stringify({protocol:1,ok:true,data:'x'.repeat(mode==='large'?3*1024*1024:2048)}));`);
  const capped = createTetherRunner({ binary: () => binary, profile: () => "test", stdoutBytes: 1024, stderrBytes: 1024 });
  for (const mode of ["stdout", "stderr"]) await expect(capped([mode])).rejects.toMatchObject({ code: "tether_output_limit" });
  const normal = createTetherRunner({ binary: () => binary, profile: () => "test" });
  expect((await normal(["large"]) as string).length).toBe(3 * 1024 * 1024);
});

test("errors never forward raw stderr, arbitrary codes, structured messages or invalid envelopes", async () => {
  const canary = "synthetic-diagnostic-canary";
  const { binary } = await fixture(`const mode=process.argv[2]; if(mode==='garbage') {console.error('${canary}'); console.log('no');} else console.log(JSON.stringify(mode==='invalid'?{protocol:1,ok:'true',data:1}:{protocol:1,ok:false,error:{code:mode==='known'?'usage':'${canary}',message:'${canary}'}}));`);
  const run = createTetherRunner({ binary: () => binary, profile: () => "test" });
  for (const mode of ["garbage", "invalid", "known", "unknown"]) {
    const error = await run([mode]).catch(error => error);
    expect(error).toBeInstanceOf(TetherError);
    if (!(error instanceof TetherError)) throw new Error("Expected a coded failure");
    expect(`${error.code} ${error.message}`).not.toContain(canary);
    if (mode === "known") expect(error.code).toBe("usage");
  }
});

test("environment keeps supported paths and explicit routing, without ambient credentials or routing", async () => {
  const { binary } = await fixture(`console.log(JSON.stringify({protocol:1,ok:true,data:{canary:process.env.TETHER_TEST_CANARY??null,home:process.env.HOME,runtime:process.env.TETHER_RUNTIME_DIR,config:process.env.XDG_CONFIG_HOME,workspace:process.env.TETHER_PASEO_WORKSPACE_ID,origin:process.env.TETHER_PASEO_ORIGIN,profile:process.env.TETHER_PROFILE}}));`);
  const old = process.env.TETHER_TEST_CANARY;
  process.env.TETHER_TEST_CANARY = "synthetic-only";
  try {
    const overrides = { HOME: "/example/home", TETHER_RUNTIME_DIR: "/example/runtime", XDG_CONFIG_HOME: "/example/config", TETHER_PASEO_WORKSPACE_ID: "ambient", TETHER_TEST_CANARY: "also-rejected" };
    const env = childEnvironment("test", overrides);
    expect(env.TETHER_PASEO_WORKSPACE_ID).toBeUndefined();
    const run = createTetherRunner({ binary: () => binary, profile: () => "test", env: overrides });
    expect(await run([], { TETHER_PASEO_WORKSPACE_ID: "explicit", TETHER_PASEO_ORIGIN: "user" })).toEqual({ canary: null, home: "/example/home", runtime: "/example/runtime", config: "/example/config", workspace: "explicit", origin: "user", profile: "test" });
  } finally { if (old === undefined) delete process.env.TETHER_TEST_CANARY; else process.env.TETHER_TEST_CANARY = old; }
});

test("source CLI cold start works and cancelling plugin work leaves the detached daemon alive", async () => {
  const root = await mkdtemp("/tmp/tether-runner-daemon-"); roots.push(root);
  const env = { TETHER_RUNTIME_DIR: join(root, "runtime"), TETHER_CONFIG_DIR: join(root, "config") };
  const controller = new AbortController();
  const options = { binary: () => resolve("tether"), profile: () => "runner-test", env };
  const control = createTetherRunner(options);
  const run = createTetherRunner({ ...options, signal: controller.signal });
  try {
    expect(await run(["folio", "list"])).toMatchObject({ files: [] });
    const initial = await run(["paseo", "wait", "--timeout", "0"]) as { cursor: number; folio: number };
    const pending = run(["paseo", "wait", "--after", String(initial.cursor), "--folio", String(initial.folio), "--timeout", "20"]);
    const caught = pending.catch(error => error);
    await Bun.sleep(100);
    expect(await run(["folio", "list"])).toMatchObject({ files: [] });
    controller.abort();
    expect(await caught).toMatchObject({ code: "tether_cancelled" });
    expect(await control(["folio", "list"])).toMatchObject({ files: [] });
  } finally { await control(["daemon", "stop"]); }
}, 15000);

test("descendant-held pipes retain capacity until output completes without killing the descendant", async () => {
  const { binary, root } = await fixture(`import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),700)"],{stdio:['ignore',1,2]}); await Bun.write(process.argv[2],String(child.pid)); child.unref(); console.log('${envelope(true)}'); process.exit(0);`);
  const pool = new ProcessPool([1, 1], 1);
  const marker = join(root, "descendant");
  const run = createTetherRunner({ binary: () => binary, profile: () => "test", pool, timeoutMs: 250 });
  const pending = run([marker]).catch(error => error);
  await until(async () => Bun.file(marker).exists());
  const pid = Number(await readFile(marker, "utf8"));
  let granted = false;
  const next = pool.acquire(false, new AbortController().signal).then(release => { granted = true; release(); });
  await Bun.sleep(60);
  expect(granted).toBe(false);
  expect(await pending).toMatchObject({ code: "tether_timeout" });
  await next;
  expect(() => process.kill(pid, 0)).not.toThrow();
  // The fixture exits itself; plugin cancellation must not take ownership of it.
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
