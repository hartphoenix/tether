import { mkdtemp, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/server/config";
import { controlLaunch } from "../src/server/lifecycle";
import { waitForDaemonStop } from "./wait-for-daemon-stop";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/check-release.ts <candidate-directory>");
const scratch = await mkdtemp(join(tmpdir(), "tether-release-check-"));
const config = resolveConfig({ configDir: join(scratch, "config"), runtimeDir: join(scratch, "runtime") });
const env = { HOME: join(scratch, "home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TETHER_CONFIG_DIR: config.configDir,
  TETHER_RUNTIME_DIR: config.runtimeDir, WAVETERM_CONFIG_DIR: join(scratch, "wave"), TETHER_SUPPRESS_BROWSER: "1" };
async function command(...args: string[]) {
  const child = Bun.spawn([join(root, "tether"), ...args], { cwd: scratch, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${err} ${out}`);
  const result = JSON.parse(out);
  if (!result.ok) throw new Error(`${args[0]} returned failure.`);
  return result.data;
}
try {
  for (const id of ["tether-review", "tetherball"]) {
    if (!(await readFile(join(root, "integrations/agents", id, "SKILL.md"), "utf8")).includes(`name: ${id}`)) throw new Error(`Missing bundled ${id}`);
  }
  const { version } = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  if (!(await readFile(join(root, "docs/releases", `${version}.md`), "utf8")).startsWith(`# Tether ${version}`)) throw new Error("Missing bundled release notes");
  if (!(await readFile(join(root, "docs/guide/paseo.md"), "utf8")).startsWith("# Tether in Paseo")) throw new Error("Missing bundled Paseo guide");
  const plugin = join(root, "integrations/paseo");
  const files = (await readdir(plugin)).sort();
  if (JSON.stringify(files) !== JSON.stringify(["LICENSE", "NOTICE.md", "index.client.ts", "index.server.ts", "package.json", "paseo-plugin.json"].sort())) throw new Error("Unexpected plugin payload");
  const client = await readFile(join(plugin, "index.client.ts"), "utf8");
  if (client.includes("moved-from-workspace") || client.includes("workspace-browser-store")) throw new Error("Personal workspace migration leaked into the release");
  for (const theme of ["Tether Light", "Tether Dark", "Light Treason", "Dark Academia"]) if (!client.includes(theme)) throw new Error(`Missing theme ${theme}`);
  if (!(await readFile(join(plugin, "NOTICE.md"), "utf8")).includes("neunzig-zehn")) throw new Error("Missing Annotations attribution");
  await writeFile(join(scratch, ".env"), "TETHER_PROFILE=invalid/profile\n");
  await command("daemon", "status");
  await chmod(join(scratch, ".env"), 0o000);
  const setup = await command("setup", "--host", "browser", "--agent-directory", join(scratch, "skills"), "--skills", "tetherball", "--no-open");
  if (setup.agents.length !== 2) throw new Error("Both skills were not registered");
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
  const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
  if (!page.ok || !script) throw new Error("Packaged reader did not serve its HTML.");
  if (!(await fetch(new URL(script, readerUrl), { headers: { cookie } })).ok) throw new Error("Packaged JavaScript is missing.");
  const cssPath = /href="(\/assets\/[^\"]+\.css)"/.exec(html)?.[1];
  if (!cssPath) throw new Error("Packaged stylesheet link missing.");
  const css = await (await fetch(new URL(cssPath, readerUrl))).text();
  if (css.includes('data:font')) throw new Error("Packaged fonts were embedded.");
  const fonts = [...css.matchAll(/url\(["']?(\/assets\/[^)'" ]+\.(?:woff2?|ttf))/g)].map(match => match[1]);
  if (!fonts.length) throw new Error("Packaged font URLs missing.");
  for (const path of fonts) {
    const response = await fetch(new URL(path, readerUrl));
    if (!response.ok || !response.headers.get('content-type')?.startsWith('font/')) throw new Error("Packaged font missing.");
  }
  const text = await readFile(setup.path, "utf8");
  await command("comment", setup.path, "--actor", "human", "--quote", "Your Markdown stays in its original file.", "--body-file", setup.path, "--operation-id", "release-smoke-comment");
  if (await readFile(setup.path, "utf8") !== text) throw new Error("A comment changed Markdown.");
  const pending = await command("pending", setup.path, "--actor", "assistant");
  if (!pending.events.length) throw new Error("The agent cannot see the welcome comment.");
  await command("daemon", "stop");
  await waitForDaemonStop([join(root, "tether")], { env, cwd: scratch });
  await command("backup", "--output", join(scratch, "backup"));
  await command("restore", "--source", join(scratch, "backup"), "--directory", join(scratch, "restored"));
  console.log(`Packaged startup, repeat setup, reader assets, review, and backup/restore passed. Evidence: ${scratch}`);
} finally {
  await command("daemon", "stop").catch(() => {});
}
