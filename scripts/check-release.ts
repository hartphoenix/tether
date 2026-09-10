import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/server/config";
import { controlLaunch } from "../src/server/lifecycle";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/check-release.ts <candidate-directory>");
const scratch = await mkdtemp(join(tmpdir(), "tether-release-check-"));
const config = resolveConfig({ configDir: join(scratch, "config"), runtimeDir: join(scratch, "runtime") });
const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TETHER_CONFIG_DIR: config.configDir,
  TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_SUPPRESS_BROWSER: "1" };
async function command(...args: string[]) {
  const child = Bun.spawn([join(root, "tether"), ...args], { cwd: scratch, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${err} ${out}`);
  const result = JSON.parse(out);
  if (!result.ok) throw new Error(`${args[0]} returned failure.`);
  return result.data;
}
try {
  const setup = await command("setup", "--host", "browser", "--agent-directory", join(scratch, "skills"), "--no-open");
  await command("setup", "--host", "browser", "--no-open");
  await command();
  const folio = await command("folio", "list");
  if (folio.files.length !== 1) throw new Error("Repeat setup duplicated the welcome document.");
  const launch = await controlLaunch(config, setup.path);
  const exchange = await fetch(launch.url, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  const location = exchange.headers.get("location");
  if (!cookie || !location) throw new Error("Launch did not create a reader session.");
  const readerUrl = new URL(location, launch.url);
  const page = await fetch(readerUrl, { headers: { cookie } });
  const html = await page.text();
  const script = /src="\.\/([^\"]+\.js)"/.exec(html)?.[1];
  if (!page.ok || !script) throw new Error("Packaged reader did not serve its HTML.");
  if (!(await fetch(new URL(script, readerUrl), { headers: { cookie } })).ok) throw new Error("Packaged JavaScript is missing.");
  const text = await readFile(setup.path, "utf8");
  await command("comment", setup.path, "--actor", "human", "--quote", "What would you like to build next?", "--body-file", setup.path, "--operation-id", "release-smoke-comment");
  if (await readFile(setup.path, "utf8") !== text) throw new Error("A comment changed Markdown.");
  const pending = await command("pending", setup.path, "--actor", "assistant");
  if (!pending.events.length) throw new Error("The agent cannot see the welcome comment.");
  await command("daemon", "stop");
  for (let i = 0; i < 40; i++) {
    if (!(await command("daemon", "status")).running) break;
    await Bun.sleep(100);
  }
  await command("backup", "--output", join(scratch, "backup"));
  await command("restore", "--source", join(scratch, "backup"), "--directory", join(scratch, "restored"));
  console.log(`Packaged startup, repeat setup, reader assets, review, and backup/restore passed. Evidence: ${scratch}`);
} finally {
  await command("daemon", "stop").catch(() => {});
}
