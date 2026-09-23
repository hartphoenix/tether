import { mkdtemp, readFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { waitForDaemonStop } from "./wait-for-daemon-stop";
const archive = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/check-install.ts <release.tar.gz>");
const hash = (await readFile(`${archive}.sha256`, "utf8")).trim().split(/\s+/)[0]!;
const scratch = await mkdtemp(join(tmpdir(), "tether-install-check-"));
const root = join(scratch, "installation with spaces"), bin = join(scratch, "bin");
const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TETHER_INSTALL_DIR: root, TETHER_BIN_DIR: bin,
  TETHER_CONFIG_DIR: join(scratch, "config"), TETHER_RUNTIME_DIR: join(scratch, "runtime"),
  WAVETERM_CONFIG_DIR: join(scratch, "wave"), TETHER_SUPPRESS_BROWSER: "1" };
async function run(args: string[], ok = true, overrides: Record<string, string> = {}) {
  const child = Bun.spawn(args, { env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (ok && code !== 0 || !ok && code === 0) throw new Error(`Unexpected command result: ${err} ${out}`);
  return out;
}
const install = ["/bin/bash", resolve("scripts/install.sh"), "--archive", archive, "--sha256", hash, "--no-open"];
const cli = (...args: string[]) => run([join(bin, "tether"), ...args]);
try {
  await run([...install.slice(0, -3), "--sha256", "0".repeat(64), "--no-open"], false);
  const mockBin = join(scratch, "download-fixture");
  await mkdir(mockBin);
  await writeFile(join(mockBin, "curl"), '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$TETHER_TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 2\n', { mode: 0o755 });
  await run(["/bin/bash", join(dirname(archive), "install.sh"), "--no-open"], true, { PATH: `${mockBin}:${env.PATH}`, TETHER_TEST_ARCHIVE: archive });
  await run(install);
  await mkdir(env.WAVETERM_CONFIG_DIR);
  await writeFile(join(env.WAVETERM_CONFIG_DIR, "widgets.json"), JSON.stringify({ unrelated: { label: "Keep me" } }));
  const plain = JSON.parse(await cli("setup", "--no-open", "--host", "browser"));
  if (!plain.data.agentSetup?.includes("After consent")) throw new Error("Setup omitted the agent-led skill opt-in guidance.");
  if (await lstat(join(env.TETHER_CONFIG_DIR, "agent-skills.json")).catch(() => null)) throw new Error("Plain setup installed an agent skill.");
  const optedIn = JSON.parse(await cli("setup", "--no-open", "--host", "browser", "--wave", "--agent-directory", join(scratch, "skills")));
  if (!optedIn.data.agent?.installed || optedIn.data.agentSetup) throw new Error("Opt-in setup did not install the skill or repeated its consent guidance.");
  await cli("daemon", "stop");
  await waitForDaemonStop([join(bin, "tether")], { env });
  await cli("uninstall", "--confirm");
  if (await lstat(join(bin, "tether")).catch(() => null)) throw new Error("Uninstall left its command launcher.");
  if (!(await lstat(join(env.TETHER_CONFIG_DIR, "tether.sqlite"))).isFile()) throw new Error("Uninstall removed private data.");
  const widgets = JSON.parse(await readFile(join(env.WAVETERM_CONFIG_DIR, "widgets.json"), "utf8"));
  if (!widgets.unrelated || Object.keys(widgets).some(key => key.startsWith("tether-"))) throw new Error("Uninstall did not preserve unrelated widgets.");
  await lstat(join(scratch, "skills/tether-review/SKILL.md"));
  console.log(`Checksum rejection, generated bootstrap, repeat install, spaced paths, skill opt-in guidance, Wave setup and recoverable uninstall passed. Evidence: ${scratch}`);
} finally {
  if (await lstat(join(bin, "tether")).catch(() => null)) await cli("daemon", "stop").catch(() => {});
}
