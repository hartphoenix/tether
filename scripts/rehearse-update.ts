import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publisherFixture } from "../tests/fixtures/publisher";
import { resolveConfig } from "../src/server/config";
import { installAgentSkill } from "../src/cli/agent-skills";
import { controlLaunch, controlRecentsLaunch, statusDaemon, stopDaemon } from "../src/server/lifecycle";
import { waitForDaemonStop } from "./wait-for-daemon-stop";

// A local rehearsal uses ephemeral test signing keys and isolated install/config/runtime directories.
// It neither reads production publisher state nor changes the normal user's installation or skills.
const verify = process.argv.includes("--verify");
if (process.argv.slice(2).some(arg => arg !== "--verify")) throw new Error("Usage: bun scripts/rehearse-update.ts [--verify]");
await mkdir(".local", { recursive: true });
const output = await mkdtemp(resolve(".local/update-rehearsal-"));
const publisher = await publisherFixture();
const base = join(publisher.directory, "rehearsal");
const config = resolveConfig({ profile: "update-rehearsal", configDir: join(base, "config"), runtimeDir: join(base, "runtime") });
const installation = join(base, "installation"), bin = join(base, "bin");
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: process.env.TMPDIR ?? "/tmp",
  TETHER_INSTALL_DIR: installation, TETHER_BIN_DIR: bin,
  TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir, TETHER_PROFILE: config.profile,
};
const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function run(args: string[], environment: Record<string, string> = env) {
  const child = Bun.spawn(args, { env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Rehearsal command failed (${code}): ${stderr}\n${stdout}`);
  return stdout;
}
const cli = async (...args: string[]) => {
  const result = JSON.parse(await run([join(bin, "tether"), ...args], { ...env, TETHER_SUPPRESS_BROWSER: "1" }));
  if (!result.ok) throw new Error(result.error?.message ?? "Rehearsal CLI failed");
  return result.data;
};
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
let finished = false;
try {
  const archives: string[] = [];
  for (const version of ["0.1.0", "0.2.0"]) {
    const candidate = join(publisher.directory, version, "candidate");
    console.log(`Building local rehearsal package ${version}…`);
    await run([process.execPath, "--no-env-file", "scripts/build-release.ts", candidate, version, publisher.root]);
    if (version === "0.2.0") {
      const skill = join(candidate, "integrations/agents/tether-review/SKILL.md");
      await writeFile(skill, await readFile(skill, "utf8") + "\nFor this update rehearsal, mention the document title in review summaries.\n");
    }
    // Create fresh rehearsal archives after preparing the simulated instruction change.
    const archive = join(publisher.directory, version, "rehearsal.tar.gz");
    await run(["/usr/bin/tar", "-czf", archive, "-C", candidate, "."], { ...env, COPYFILE_DISABLE: "1" });
    archives.push(archive);
  }
  await publisher.publish(archives[1]!);
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archives[0]!).arrayBuffer()).digest("hex");
  await run(["/bin/bash", resolve("scripts/install.sh"), "--archive", archives[0]!, "--sha256", hash, "--no-open"]);
  const installedRoot = await realpath(join(installation, "current"));
  const skills: Record<string, string> = {};
  for (const name of ["automatic", "use-updated", "keep-customized", "merge-customized"]) {
    const skill = await installAgentSkill(join(base, "skills", name), config, installedRoot);
    skills[name] = skill.path;
    if (name !== "automatic") await writeFile(skill.path, await readFile(skill.path, "utf8") + `\nMy rehearsal preference (${name}): use short paragraphs.\n`);
  }
  const document = join(base, "Update rehearsal.md");
  await writeFile(document, "# Update rehearsal\n\nThis document belongs to an isolated test installation.\n\nLeave a comment or edit this paragraph before updating. Your normal Tether documents and settings are separate.\n");
  const note = join(base, "comment.txt"); await writeFile(note, "This thread should survive the update.");
  await cli("comment", document, "--actor", "human", "--quote", "Leave a comment or edit this paragraph before updating.", "--body-file", note, "--operation-id", "rehearsal-comment");
  const checked = await cli("update", "--check");
  assert(checked.available?.version === "0.2.0", "Local signed update was not discovered");
  const prefix = `#!/bin/bash\nset -euo pipefail\nexec env ${Object.entries(env).map(([key, value]) => `${key}=${shell(value)}`).join(" ")} ${shell(join(bin, "tether"))}`;
  await writeFile(join(output, "Open reader.command"), `${prefix} open ${shell(document)} --host browser\n`, { mode: 0o700 });
  await writeFile(join(output, "Open Folio.command"), `${prefix} folio --host browser\n`, { mode: 0o700 });
  await writeFile(join(output, "Stop rehearsal.command"), `#!/bin/bash\nset -euo pipefail\ntouch ${shell(join(output, "stop"))}\n`, { mode: 0o700 });
  await writeFile(join(output, "README.md"), `# Local update rehearsal\n\nThis disposable installation runs entirely on your Mac with test signing keys. Your normal installation, documents, agent skills, and publisher state are separate.\n\n1. Run **Open reader.command** or **Open Folio.command** in this folder. The reader has a sample document and review thread.\n2. Click the **Update Available** package icon in the center of the topbar to open the update controls. When no update is available, **Check for updates** is in the Folio menu. Version 0.2.0 is the simulated update. Its Release Notes link uses a simulated GitHub tag, not a published release.\n3. Edit or comment on the document, then choose **Install**. Check that your work survives and the reader reconnects. Folio reloads after the update.\n4. Choose **Review agent instructions**. The untouched test skill updates automatically. Three customized copies let you try **Accept new version**, **Keep old version**, and **Ask my agent to merge** separately.\n5. For the merge, paste the copied prompt into your agent chat. Discuss any preferences, review the proposed changes, and approve them there. Your agent applies the merge and clears the notice; you do not need to return to Tether. The release-notes link is synthetic in this rehearsal, so the agent should report that those notes are unavailable.\n6. Run **Stop rehearsal.command** when finished. This stops the local test services and removes the disposable installation and its data. This guide and verification output remain.\n\nKeep the rehearsal process running while testing. To start a new rehearsal from the source checkout, run \`bun scripts/rehearse-update.ts\`. Each run creates separate test state.\n\nThis exercises package updating and skill review on your existing account. It does not establish fresh-account installation or availability of public release endpoints.\n`);
  console.log(`Rehearsal ready: ${output}`);
  if (verify) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto((await controlLaunch(config, document)).url);
      await page.getByRole("button", { name: "Update Available", exact: true }).click();
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByRole("button", { name: "Review agent instructions", exact: true }).waitFor({ timeout: 120_000 });
      assert((await statusDaemon(config)).version === "0.2.0", "Updated daemon has wrong version");
      assert((await cli("pending", document, "--actor", "assistant")).events.length > 0, "Review was lost");
      assert((await readFile(skills.automatic!, "utf8")).includes("mention the document title"), "Untouched skill did not update");
      await page.getByRole("button", { name: "Review agent instructions", exact: true }).click();
      await page.locator(".review-card").filter({ has: page.getByTitle(skills["use-updated"]!, { exact: true }) }).getByRole("button", { name: "Accept new version", exact: true }).click();
      await page.getByTitle(skills["use-updated"]!, { exact: true }).waitFor({ state: "detached" });
      assert(!(await readFile(skills["use-updated"]!, "utf8")).includes("My rehearsal preference"), "Replacement failed");
      await page.locator(".review-card").filter({ has: page.getByTitle(skills["keep-customized"]!, { exact: true }) }).getByRole("button", { name: "Keep old version", exact: true }).click();
      await page.getByTitle(skills["keep-customized"]!, { exact: true }).waitFor({ state: "detached" });
      assert((await readFile(skills["keep-customized"]!, "utf8")).includes("My rehearsal preference"), "Keep discarded customizations");
      const entries = await cli("skills", "list");
      const review = await cli("skills", "read", entries.reviews[0].id);
      await writeFile(review.candidatePath, `${review.proposed}\nMy rehearsal preference (merge-customized): use short paragraphs.\n`);
      await page.screenshot({ path: join(output, "skill-review.png"), fullPage: true });
      // Simulate approval given in agent chat and completion through the public CLI.
      await cli("skills", "merge", review.id, "--expected-revision", review.sourceRevision, "--body-file", review.candidatePath, "--confirm");
      const merged = await readFile(skills["merge-customized"]!, "utf8");
      assert(merged.includes("mention the document title") && merged.includes("My rehearsal preference"), "Merge lost instructions");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      const folio = await context.newPage(); await folio.goto((await controlRecentsLaunch(config)).url);
      await folio.getByRole("button", { name: "Folio menu", exact: true }).click();
      await folio.getByRole("button", { name: "Check for updates", exact: true }).waitFor();
      const doctor = await cli("doctor"); assert(doctor.agentSkillReviews.length === 0, "Decisions did not clear pending reviews");
      await writeFile(join(output, "verification.txt"), "Passed: real local signed package update through the reader UI; thread preservation; automatic skill refresh; replacement, keep, and merged approval; Folio update control; no pending skill reviews.\n");
      console.log("Browser rehearsal passed.");
    } finally { await browser.close(); }
  } else {
    await new Promise<void>(done => {
      const timer = setInterval(async () => { if (await Bun.file(join(output, "stop")).exists()) { clearInterval(timer); done(); } }, 1000);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { clearInterval(timer); done(); });
    });
  }
  finished = true;
} finally {
  await stopDaemon(config).catch(() => {});
  await waitForDaemonStop([join(bin, "mdreview")], { env, timeoutMs: 10_000 }).catch(() => {});
  await publisher.close();
  await writeFile(join(output, "status.txt"), finished ? "Rehearsal stopped. Disposable test state removed.\n" : "Rehearsal failed. Disposable test state removed.\n");
}
