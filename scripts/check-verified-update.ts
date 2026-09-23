import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publisherFixture } from "../tests/fixtures/publisher";
import { resolveConfig } from "../src/server/config";
import { controlLaunch, controlRecentsLaunch, statusDaemon, stopDaemon } from "../src/server/lifecycle";
import { waitForDaemonStop } from "./wait-for-daemon-stop";

// Two real packages, ephemeral in-memory publisher keys, isolated profiles only.
const publisher = await publisherFixture();
const scratch = publisher.directory;
const configs: ReturnType<typeof resolveConfig>[] = [];
async function run(args: string[], env?: Record<string, string>, ok = true) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if ((code === 0) !== ok) throw new Error(`Unexpected exit ${code}: ${stderr}\n${stdout}`);
  return stdout;
}
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
try {
  const archives: string[] = [];
  for (const version of ["0.1.0", "0.2.0"]) {
    const destination = join(scratch, version, "candidate");
    await run([process.execPath, "--no-env-file", "scripts/build-release.ts", destination, version, publisher.root]);
    archives.push(join(scratch, version, `tether-${process.platform}-${process.arch}.tar.gz`));
  }
  await publisher.publish(archives[1]!);
  for (const mode of ["cli", "reader", "folio"]) {
    const base = join(scratch, mode), installation = join(base, "installation"), bin = join(base, "bin");
    const config = resolveConfig({ profile: "verified-check", configDir: join(base, "config"), runtimeDir: join(base, "runtime") });
    configs.push(config);
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base, TMPDIR: "/tmp", TETHER_INSTALL_DIR: installation, TETHER_BIN_DIR: bin,
      TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_PROFILE: config.profile, TETHER_SUPPRESS_BROWSER: "1" };
    const hash = (await readFile(`${archives[0]}.sha256`, "utf8")).split(/\s/)[0]!;
    await run(["/bin/bash", resolve("scripts/install.sh"), "--archive", archives[0]!, "--sha256", hash, "--no-open"], env);
    await run(["/bin/bash", resolve("scripts/install.sh"), "--archive", archives[1]!, "--sha256", (await readFile(`${archives[1]}.sha256`, "utf8")).split(/\s/)[0]!, "--version", "v0.9.9", "--no-open"], env, false);
    assert(JSON.parse(await readFile(join(installation, "current/release.json"), "utf8")).version === "0.1.0", "Version mismatch changed active installation");
    const cli = async (...args: string[]) => {
      const envelope = JSON.parse(await run([join(bin, "mdreview"), ...args], env));
      assert(envelope.ok, "CLI failure"); return envelope.data;
    };
    const path = join(base, "doc.md"); await writeFile(path, "# Verified update\n\nKeep this review.\n");
    const note = join(base, "note.txt"); await writeFile(note, "Retain this thread.");
    await cli("comment", path, "--actor", "human", "--quote", "Keep this review.", "--body-file", note, "--operation-id", "verified-package-comment");
    const exchange = async (url: string) => {
      const response = await fetch(url, { redirect: "manual" });
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      return { cookie, url: new URL(response.headers.get("location")!, url) };
    };
    const reader = await exchange((await controlLaunch(config, path)).url);
    const folio = await exchange((await controlRecentsLaunch(config)).url);
    const initial = await (await fetch(new URL("api/bootstrap", reader.url), { headers: { cookie: reader.cookie } })).json() as any;
    assert((await fetch(new URL("api/draft", reader.url), { method: "POST", headers: { cookie: reader.cookie, origin: reader.url.origin, "content-type": "application/json" }, body: JSON.stringify({ body: "Unsaved draft", baseRevision: initial.document.bodyRevision, scroll: 123 }) })).ok, "Draft write failed");
    const before = await statusDaemon(config);
    if (mode === "cli") {
      const checked = await cli("update", "--check"); assert(checked.available?.version === "0.2.0", "CLI discovery failed");
      await cli("daemon", "stop"); await waitForDaemonStop([join(bin, "mdreview")], { env });
      await cli("update", "--version", "v0.2.0"); await cli("pending", path, "--actor", "assistant");
    } else {
      const view = mode === "reader" ? reader : folio;
      const checked = await (await fetch(new URL("api/updates/check", view.url), { method: "POST", headers: { cookie: view.cookie, origin: view.url.origin, "content-type": "application/json" }, body: "{}" })).json() as any;
      assert(checked.available?.version === "0.2.0", `${mode} discovery failed`);
      assert((await fetch(new URL("api/updates/install", view.url), { method: "POST", headers: { cookie: view.cookie, origin: view.url.origin, "content-type": "application/json" }, body: JSON.stringify({ tag: checked.available.tag }) })).ok, `${mode} install failed`);
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        // The old discovery record can briefly outlive its listener during replacement.
        const current = await statusDaemon(config).catch(cause => {
          if (cause?.code === "daemon_unreachable") return undefined;
          throw cause;
        });
        if (current?.running && current.instanceId !== before.instanceId) break;
        await Bun.sleep(250);
      }
    }
    const selected = await realpath(join(installation, "current"));
    assert(JSON.parse(await readFile(join(selected, "release.json"), "utf8")).version === "0.2.0", "New package was not selected");
    const state = await statusDaemon(config); assert(state.version === "0.2.0", "Running daemon reports the wrong release"); assert(state.running && state.instanceId !== before.instanceId, "New daemon was not started");
    const recovered = await (await fetch(new URL("api/bootstrap", reader.url), { headers: { cookie: reader.cookie } })).json() as any;
    assert(recovered.draft?.body === "Unsaved draft" && recovered.draft?.baseRevision === initial.document.bodyRevision && recovered.draft?.scroll === 123, "Draft or conflict base lost");
    assert((await fetch(folio.url, { headers: { cookie: folio.cookie } })).ok, "Folio did not resume");
    assert((await cli("pending", path, "--actor", "assistant")).events.length, "Review lost");
    const backup = (await readdir(base)).find(name => name.startsWith("backup-before-update-")); assert(backup, "Backup missing");
    await cli("daemon", "stop"); await waitForDaemonStop([join(bin, "mdreview")], { env });
    await cli("restore", "--source", join(base, backup!), "--directory", join(base, "restored"));
    console.log(`${mode}: signed discovery, packaged update, backup, new daemon, scoped reader/Folio/draft/review recovery, isolated restore passed`);
  }
} finally {
  for (const config of configs) await stopDaemon(config).catch(() => {});
  await publisher.close();
}
