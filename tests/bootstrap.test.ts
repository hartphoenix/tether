import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBootstrap, renderBootstrap } from "../scripts/build-bootstrap";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp("/tmp/tether-bootstrap-"); directories.push(dir);
  const mock = join(dir, "mock"), app = join(dir, "app"), root = join(dir, "install with spaces");
  await mkdir(mock); await mkdir(join(app, "runtime"), { recursive: true });
  await writeFile(join(mock, "uname"), '#!/bin/bash\nif [ "$1" = -s ]; then echo "${TEST_PLATFORM:-Darwin}"; else echo "${TEST_ARCH:-arm64}"; fi\n', { mode: 0o755 });
  await writeFile(join(mock, "curl"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_CURL_LOG"\n[ "${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 2\n', { mode: 0o755 });
  const env = { PATH: `${mock}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir, TMPDIR: dir,
    TETHER_INSTALL_DIR: root, TETHER_BIN_DIR: join(dir, "bin"), TEST_ARCHIVE: join(dir, "release.tar.gz"),
    TEST_CURL_LOG: join(dir, "download.log"), TEST_SETUP_LOG: join(dir, "setup.log") };
  // A minimal package exercises real installation without opening a host or daemon.
  await writeFile(join(app, "release.json"), JSON.stringify({ version: "1.2.3", platform: "darwin", architecture: "arm64" }));
  for (const name of ["tether", "mdreview"]) await writeFile(join(app, name), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$TEST_SETUP_LOG"\n', { mode: 0o755 });
  await writeFile(join(app, "runtime/bun"), `#!/bin/bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const tar = Bun.spawn(["/usr/bin/tar", "-czf", env.TEST_ARCHIVE, "-C", app, "."], { env, stdout: "pipe", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  const bootstrap = join(dir, "install.sh");
  await buildBootstrap("1.2.3", bootstrap, [env.TEST_ARCHIVE]);
  const run = async (args: string[] = [], overrides: Record<string, string> = {}, piped = false) => {
    const child = Bun.spawn(piped ? ["/bin/bash", "-s", "--", ...args] : ["/bin/bash", bootstrap, ...args], { stdin: piped ? Bun.file(bootstrap) : "ignore", env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  return { dir, root, env, bootstrap, run };
}

test("bootstrap rejects failed downloads, wrong hashes and unsupported machines before installing", async () => {
  const f = await fixture();
  expect((await f.run([], { TEST_DOWNLOAD_FAIL: "1" })).code).not.toBe(0);
  expect((await f.run([], { TEST_PLATFORM: "Linux" })).err).toContain("macOS only");
  expect((await f.run([], { TEST_ARCH: "x86_64" })).err).toContain("no package");
  expect((await f.run(["--unexpected"])).code).toBe(2);
  await writeFile(f.env.TEST_ARCHIVE, "tampered archive");
  expect((await f.run()).err).toContain("checksum mismatch");
  expect(await Bun.file(join(f.root, "current/tether")).exists()).toBe(false);
  expect(await Bun.file(f.env.TEST_SETUP_LOG).exists()).toBe(false);
});

test.skipIf(process.platform !== "darwin")("bootstrap installs through spaced paths, opens setup, and uses the installed verifier on repeat", async () => {
  const f = await fixture();
  const first = await f.run([], {}, true);
  expect(first.code).toBe(0);
  expect(await readFile(f.env.TEST_SETUP_LOG, "utf8")).toBe("setup\n");
  expect(await realpath(join(f.env.TETHER_BIN_DIR, "tether"))).toBe(await realpath(join(f.root, "current/tether")));
  expect(first.out).toContain('export PATH=');
  const download = await readFile(f.env.TEST_CURL_LOG, "utf8");
  expect(download).toContain("/releases/download/v1.2.3/tether-darwin-arm64.tar.gz");
  expect(download).toContain("--proto-redir\n=https");
  expect((await f.run([], { TEST_DOWNLOAD_FAIL: "1" })).code).toBe(0);
  expect(await readFile(f.env.TEST_SETUP_LOG, "utf8")).toBe("setup\nupdate\n");
});

test.skipIf(process.platform !== "darwin")("bootstrap --no-open installs without invoking setup", async () => {
  const f = await fixture();
  expect((await f.run(["--no-open"])).code).toBe(0);
  expect(await Bun.file(join(f.root, "current/tether")).exists()).toBe(true);
  expect(await Bun.file(f.env.TEST_SETUP_LOG).exists()).toBe(false);
});

test("bootstrap generation validates archive identities and preserves existing output", async () => {
  const f = await fixture();
  await expect(buildBootstrap("9.9.9", join(f.dir, "other.sh"), [f.env.TEST_ARCHIVE])).rejects.toThrow("match");
  await expect(buildBootstrap("1.2.3", f.bootstrap, [f.env.TEST_ARCHIVE])).rejects.toThrow();
  await expect(buildBootstrap("1.2.3", join(f.dir, "duplicate.sh"), [f.env.TEST_ARCHIVE, f.env.TEST_ARCHIVE])).rejects.toThrow("duplicate");
  const archives = [{ architecture: "arm64" as const, sha256: "a".repeat(64) }, { architecture: "x64" as const, sha256: "b".repeat(64) }];
  const output = renderBootstrap("1.2.3", archives, "exit 0");
  expect(output).toContain("x86_64) asset=tether-darwin-x64.tar.gz");
  expect(() => renderBootstrap("1.2.3; echo bad", archives, "exit 0")).toThrow();
});
