import { cp, mkdir, mkdtemp, readFile, symlink, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { setupPaseo, removeManagedPaseo } from "../src/cli/paseo-setup";
import { waitForDaemonStop } from "./wait-for-daemon-stop";

const candidate = resolve(process.argv[2] ?? ""), executable = process.argv[3];
if (!process.argv[2] || !executable) throw new Error("Usage: bun scripts/check-paseo-package.ts <candidate-directory> <paseo-cli>");
const base = await mkdtemp("/tmp/tether-paseo-package-"), home = join(base, "paseo"), root = join(base, "installation/releases/one");
await mkdir(home, { recursive: true });
await mkdir(join(base, "user"));
await cp(candidate, root, { recursive: true });
await symlink(root, join(base, "installation/current"));
const env = { HOME: join(base, "user"), PATH: `${root}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: "/tmp", TETHER_PROFILE: "paseo-package-check", TETHER_CONFIG_DIR: join(base, "tether-config"), TETHER_RUNTIME_DIR: join(base, "tether-runtime"), TETHER_SUPPRESS_BROWSER: "1" };
const configPath = join(home, "config.json");
await writeFile(configPath, JSON.stringify({ daemon: { listen: join(home, "daemon.sock") }, pluginsEnabled: false }));
async function run(exe: string, args: string[]) {
  const child = Bun.spawn([exe, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Isolated command failed (${args.slice(0, 2).join(" ")}): ${out} ${err}`);
    return out;
  } finally { clearTimeout(timer); }
}
const daemon = (...args: string[]) => run(executable, ["daemon", ...args, "--home", home]);
const host = { id: "paseo" as const, installed: true, cli: executable, version: "0.11.2", active: false, connected: false };
try {
  assert.match(await run(executable, ["--version"]), /0\.11\.2/);
  await daemon("start", "--timeout", "30");
  const first = await setupPaseo(host, { root, home, run });
  assert.equal(first.status, "disabled");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.pluginsEnabled, false);
  assert.equal(config.plugins.tether.path, join(base, "installation/current/integrations/paseo"));
  await daemon("stop");
  config.pluginsEnabled = true;
  await writeFile(configPath, JSON.stringify(config));
  await daemon("start", "--timeout", "30");
  const loaded = await setupPaseo(host, { root, home, run });
  assert.notEqual(loaded.status, "failed");
  assert.notEqual(loaded.status, "disabled");
  const next = join(base, "installation/releases/two");
  await cp(root, next, { recursive: true });
  await symlink(next, join(base, "installation/next"));
  await rename(join(base, "installation/next"), join(base, "installation/current"));
  const upgraded = await setupPaseo(host, { root: next, home, run });
  assert.equal(upgraded.path, first.path);
  assert.notEqual(upgraded.status, "failed");
  await run(executable, ["plugin", "disable", "tether", "--home", home, "--json"]);
  assert.equal((await setupPaseo(host, { root: next, home, run })).enabled, false);
  assert.equal(await removeManagedPaseo(host, { root: next, home, run }), true);
  console.log(`Paseo 0.11.2: packaged directory install, disabled-state preservation, runtime compilation/loading, current-pointer upgrade/reload, and removal passed. Evidence: ${base}`);
} finally {
  await daemon("stop").catch(() => {});
  await run(join(root, "tether"), ["daemon", "stop"]).catch(() => {});
  await waitForDaemonStop([join(root, "tether")], { env }).catch(() => {});
}
