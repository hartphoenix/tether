import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireStartupLock, prepareConfig, readDiscovery, removeStaleRuntime, resolveConfig, validateProfile } from "../src/server/config";
import { controlLaunch, discoverDaemon } from "../src/server/lifecycle";

const directories: string[] = [];
const daemonPids = new Set<number>();
const repository = join(import.meta.dir, "..");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for process state.");
    await Bun.sleep(50);
  }
}

function cleanEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ["PATH", "TMPDIR", "LANG", "LC_ALL"];
  const base = Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { ...base, ...overrides };
}

async function command(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: repository, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  for (const pid of daemonPids) {
    if (alive(pid)) process.kill(pid, "SIGTERM");
  }
  daemonPids.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("validates private profile configuration and non-secret discovery", async () => {
  expect(() => validateProfile("../unsafe")).toThrow();
  expect(validateProfile("preview_1")).toBe("preview_1");
  const directory = await mkdtemp(join("/tmp", "tether-config-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "preview", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  await prepareConfig(config);
  expect((await stat(config.runtimeDir)).mode & 0o077).toBe(0);
  expect((await stat(config.configDir)).mode & 0o077).toBe(0);
  await writeFile(config.discoveryPath, JSON.stringify({ protocol: 1, instanceId: "old", pid: 999_999_999, origin: "http://127.0.0.1:9", startedAt: new Date(0).toISOString() }), { mode: 0o600 });
  const discovery = await readDiscovery(config);
  expect(discovery).toMatchObject({ protocol: 1, instanceId: "old", pid: 999_999_999 });
  expect(JSON.stringify(discovery)).not.toContain("token");
});

test("startup locks exclude peers on empty and legacy files without replacing the inode", async () => {
  const directory = await mkdtemp("/tmp/tether-startup-lock-");
  directories.push(directory);
  const config = resolveConfig({ runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  await prepareConfig(config);
  for (const contents of ["", JSON.stringify({ pid: 999_999_999 })]) {
    await writeFile(config.lockPath, contents, { mode: 0o600 });
    const inode = (await stat(config.lockPath)).ino;
    const first = await acquireStartupLock(config);
    try {
      await expect(acquireStartupLock(config)).rejects.toMatchObject({ code: "writer_busy" });
      await expect(removeStaleRuntime(config)).rejects.toMatchObject({ code: "writer_busy" });
    } finally { await first.release(); }
    const next = await acquireStartupLock(config);
    await next.release();
    await removeStaleRuntime(config);
    expect((await stat(config.lockPath)).ino).toBe(inode);
  }
});

test("startup lock ownership releases when a launcher crashes", async () => {
  const directory = await mkdtemp("/tmp/tether-startup-crash-");
  directories.push(directory);
  const config = resolveConfig({ runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const module = new URL("../src/server/config.ts", import.meta.url).pathname;
  const script = `import { acquireStartupLock } from ${JSON.stringify(module)};
    const lock = await acquireStartupLock(${JSON.stringify(config)});
    console.log('locked'); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    await expect(acquireStartupLock(config)).rejects.toMatchObject({ code: "writer_busy" });
    child.kill(9);
    await child.exited;
    const lock = await acquireStartupLock(config);
    await lock.release();
  } finally { child.kill(); await child.exited; }
});

test("simultaneous source-checkout launchers recover stale state, reuse one daemon, and stop it cleanly", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-process-"));
  directories.push(directory);
  const path = join(directory, "copied-file.md");
  await writeFile(path, "# Process fixture\n");
  const config = resolveConfig({ profile: "process", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(config.discoveryPath, JSON.stringify({ protocol: 1, instanceId: "stale", pid: 999_999_999, origin: "http://127.0.0.1:9", startedAt: new Date(0).toISOString() }), { mode: 0o600 });
  await writeFile(config.lockPath, JSON.stringify({ pid: 999_999_999 }), { mode: 0o600 });
  const env = cleanEnvironment({
    TETHER_PROFILE: "process",
    TETHER_RUNTIME_DIR: config.runtimeDir,
    TETHER_CONFIG_DIR: config.configDir,
    TETHER_SUPPRESS_BROWSER: "1",
  });

  // Observe each cold launcher's own discovery result, before later CLI calls
  // could hide a split startup by both reading the final discovery file.
  const module = new URL("../src/server/lifecycle.ts", import.meta.url).pathname;
  const script = `import { ensureDaemon } from ${JSON.stringify(module)};
    const daemon = await ensureDaemon();
    console.log(JSON.stringify({ instanceId: daemon.instanceId, pid: daemon.pid }));`;
  const launches = await Promise.all([
    command(["-e", script], env), command(["-e", script], env),
  ]);
  const instances = launches.map(result => {
    expect(result.exitCode, result.stderr).toBe(0);
    const instance = JSON.parse(result.stdout) as { instanceId: string; pid: number };
    daemonPids.add(instance.pid);
    return instance;
  });
  expect(instances[0]).toEqual(instances[1]);

  const [first, second] = await Promise.all([
    command(["mdreview", "open", path], env),
    command(["mdreview", "open", path], env),
  ]);
  for (const result of [first, second]) {
    expect(result.exitCode, result.stderr || JSON.stringify(JSON.parse(result.stdout).error)).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ protocol: 1, ok: true, command: "open", data: { opened: false } });
  }
  const discovery = await discoverDaemon(config);
  expect(discovery).not.toBeNull();
  daemonPids.add(discovery!.pid);
  expect(discovery!.instanceId).not.toBe("stale");
  expect((await stat(config.discoveryPath)).mode & 0o077).toBe(0);
  expect((await stat(config.controlPath)).mode & 0o077).toBe(0);
  expect(await readFile(config.discoveryPath, "utf8")).not.toContain(await readFile(config.controlPath, "utf8"));

  const agentRead = await command(["mdreview", "document", "read", path], env);
  expect(agentRead.stderr).toBe("");
  expect(agentRead.stdout.trim().split("\n")).toHaveLength(1);
  const readPayload = JSON.parse(agentRead.stdout) as { data: { bodyRevision: string } };
  const agentSave = await command([
    "mdreview", "document", "save", path,
    "--expected-body-revision", readPayload.data.bodyRevision,
    "--body-file", "-",
  ], env, "# Revised through stdin\n\nSecond line.\n");
  expect(agentSave.exitCode).toBe(0);
  expect(agentSave.stderr).toBe("");
  expect(JSON.parse(agentSave.stdout)).toMatchObject({ protocol: 1, ok: true, command: "document.save" });
  expect(await readFile(path, "utf8")).toBe("# Revised through stdin\n\nSecond line.\n");
  expect((await discoverDaemon(config))?.instanceId).toBe(discovery!.instanceId);

  const recentOne = join(directory, "recent-one.md");
  const recentTwo = join(directory, "recent-two.md");
  await writeFile(recentOne, "One\n");
  await writeFile(recentTwo, "Two\n");
  const recentAdds = await Promise.all([
    command(["mdreview", "recents", "add", recentOne], env),
    command(["mdreview", "recents", "add", recentTwo], env),
  ]);
  expect(recentAdds.every((result) => result.exitCode === 0)).toBe(true);
  const recentList = await command(["mdreview", "folio", "list"], env);
  expect(recentList.exitCode).toBe(0);
  expect(recentList.stderr).toBe("");
  const recentPayload = JSON.parse(recentList.stdout) as { ok: boolean; data?: { files?: Array<{ path: string }> } };
  expect(recentPayload.ok).toBe(true);
  const recentPaths = recentPayload.data?.files?.map((file) => file.path) ?? [];
  expect(recentPaths).toContain(await realpath(recentOne));
  expect(recentPaths).toContain(await realpath(recentTwo));

  const launch = await controlLaunch(config, path);
  const exchange = await fetch(launch.url, { redirect: "manual" });
  const location = exchange.headers.get("location")!;
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];
  const editor = await fetch(`${discovery!.origin}${location}`, { headers: { cookie } });
  expect(editor.status).toBe(200);
  expect(await editor.text()).toContain("<title>Tether</title>");

  const status = await command(["mdreview", "daemon", "status"], env);
  expect(JSON.parse(status.stdout)).toMatchObject({ protocol: 1, ok: true, command: "daemon.status", data: { running: true, instanceId: discovery!.instanceId } });
  const stopped = await command(["mdreview", "daemon", "stop"], env);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ protocol: 1, ok: true, command: "daemon.stop", data: { stopping: true } });
  await waitUntil(() => !alive(discovery!.pid));
  daemonPids.delete(discovery!.pid);
  expect(await discoverDaemon(config)).toBeNull();
});

test("a real idle daemon awaits server closure and exits without spinning", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-idle-process-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "idle", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const env = cleanEnvironment({
    TETHER_PROFILE: "idle",
    TETHER_RUNTIME_DIR: config.runtimeDir,
    TETHER_CONFIG_DIR: config.configDir,
    TETHER_STARTUP_GRACE_MS: "0",
    TETHER_IDLE_MS: "0",
  });
  const child = Bun.spawn([process.execPath, "src/server/daemon.ts"], { cwd: repository, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  daemonPids.add(child.pid);
  const exitCode = await Promise.race([child.exited, Bun.sleep(5_000).then(() => -1)]);
  if (exitCode === -1) throw new Error(`Idle daemon stayed alive: ${await new Response(child.stderr).text()}`);
  expect(exitCode).toBe(0);
  daemonPids.delete(child.pid);
  expect(await discoverDaemon(config)).toBeNull();
});
