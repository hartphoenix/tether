import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { resolveConfig } from "../src/server/config";
import { UpdateService, newerVersion } from "../src/server/updates";
import { completeManagedUpdate } from "../src/server/daemon";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
function release(tag = "v0.2.0") {
  return { tag_name: tag, draft: false, prerelease: false, assets: ["tether-darwin-arm64.tar.gz", "tether-darwin-arm64.tar.gz.sha256"].map(name => ({ name, browser_download_url: `https://github.com/hartphoenix/tether/releases/download/${tag}/${name}` })) };
}
async function fixture() {
  const dir = await mkdtemp("/tmp/tether-updates-"); directories.push(dir);
  const root = join(dir, "releases/old");
  await mkdir(root, { recursive: true });
  await symlink(root, join(dir, "current"));
  await writeFile(join(dir, "install.json"), "{}");
  await writeFile(join(root, "release.json"), '{"version":"0.1.0"}');
  const config = resolveConfig({ configDir: join(dir, "config"), runtimeDir: join(dir, "runtime") });
  await mkdir(config.configDir);
  let calls = 0, installs = 0, now = 0;
  let response: unknown = release();
  const options = { config, root, architecture: "arm64", now: () => now, fetch: async () => { calls++; return Response.json(response); }, install: async () => { installs++; } };
  return { options, service: new UpdateService(options), calls: () => calls, installs: () => installs, advance: () => { now += 6 * 60 * 60 * 1000; }, release: (value: unknown) => { response = value; } };
}

test("compares numeric stable versions and rejects prereleases and malformed tags", () => {
  expect(newerVersion("0.10.0", "0.9.9")).toBe(true);
  expect(newerVersion("1.0.0", "0.99.99")).toBe(true);
  for (const version of ["0.1.0", "0.0.9", "0.2.0-rc.1", "garbage", "1.2", "v0.2.0"]) expect(newerVersion(version, "0.1.0")).toBe(false);
});

test("coalesces checks, persists dismissal across restarts, resurfaces the next version", async () => {
  const f = await fixture();
  const results = await Promise.all([f.service.status(), f.service.status()]);
  expect(f.calls()).toBe(1);
  expect(results[0]!.available?.version).toBe("0.2.0");
  await f.service.dismiss("v0.2.0");
  expect((await f.service.status()).available).toBeNull();
  expect((await new UpdateService(f.options).status()).available).toBeNull();
  f.release(release("v0.3.0")); f.advance();
  expect((await f.service.status()).available?.version).toBe("0.3.0");
  await expect(f.service.install("v0.2.0")).rejects.toThrow();
  await Promise.all([f.service.install("v0.3.0"), f.service.install("v0.3.0")]);
  expect(f.installs()).toBe(1);
  expect((await f.service.status()).installing).toBe(true);
});

test("requires matching architecture assets, stable releases, and a newer version", async () => {
  const f = await fixture();
  for (const value of [release("v0.1.0"), release("v0.0.1"), release("v0.2.0-rc.1"), { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), assets: [] }, { ...release(), assets: [{ name: "tether-darwin-arm64.tar.gz", browser_download_url: "https://evil.invalid" }] }]) {
    f.release(value); f.advance();
    expect((await f.service.status()).available).toBeNull();
  }
});

test("source checkouts never check or install; failed checks are silent and bounded", async () => {
  const f = await fixture();
  const source = new UpdateService({ ...f.options, root: undefined });
  expect((await source.status()).available).toBeNull();
  expect(f.calls()).toBe(0);
  await expect(source.install("v0.2.0")).rejects.toThrow();
  let calls = 0;
  const offline = new UpdateService({ ...f.options, fetch: async () => { calls++; throw new Error("Offline"); } });
  expect((await offline.status()).available).toBeNull();
  await offline.status();
  expect(calls).toBe(1);
  f.advance(); await offline.status();
  expect(calls).toBe(2);
});

test("update supervisor invokes the pinned backup/update command and relaunches the selected runtime", async () => {
  const f = await fixture();
  const commands: string[][] = [];
  let launches = 0;
  const next = join(dirname(f.options.root), "new");
  await mkdir(next);
  await completeManagedUpdate(f.options.config, f.options.root, "v0.2.0", {
    run: async command => {
      commands.push(command);
      const current = join(dirname(dirname(f.options.root)), "current");
      await unlink(current); await symlink(next, current);
      return 0;
    },
    launch: async options => {
      launches++;
      const selected = await realpath(next);
      expect(options?.command).toEqual([join(selected, "runtime/bun"), join(selected, "lib/daemon.js")]);
      expect(options?.config).toEqual(f.options.config);
      expect(options?.env?.TETHER_INSTALL_ROOT).toBe(selected);
      return {} as never;
    },
  });
  expect(commands).toEqual([[join(f.options.root, "mdreview"), "update", "--version", "v0.2.0"]]);
  expect(launches).toBe(1);
});

test("installer failure restores service with a retry notice; failed new-runtime startup never downgrades", async () => {
  const f = await fixture();
  await completeManagedUpdate(f.options.config, f.options.root, "v0.2.0", {
    run: async () => 1,
    launch: async options => { expect(options?.env?.TETHER_INSTALL_ROOT).toBe(await realpath(f.options.root)); return {} as never; },
  });
  expect(JSON.parse(await readFile(join(f.options.config.configDir, "updates.json"), "utf8"))).toEqual({ failed: true });
  let launches = 0;
  await expect(completeManagedUpdate(f.options.config, f.options.root, "v0.2.0", {
    run: async () => 0,
    launch: async () => { launches++; throw new Error("New daemon unavailable"); },
  })).rejects.toThrow("New daemon unavailable");
  expect(launches).toBe(1);
});
