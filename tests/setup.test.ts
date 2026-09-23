import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfig } from "../src/server/config";
import { seedWelcome, installAgentSkill, readHostPreference, saveHostPreference } from "../src/cli/setup";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
test("onboarding preserves edits and agent setup refuses a differing existing skill", async () => {
  const directory = await mkdtemp("/tmp/tether-setup-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  const path = await seedWelcome(config);
  expect(await readFile(path, "utf8")).toContain(path);
  expect(await readFile(path, "utf8")).not.toContain("{{DOCUMENT_PATH}}");
  const banner = join(config.configDir, "documents/assets/tether-banner.png");
  expect(await readFile(banner)).toEqual(await readFile("docs/assets/tether-banner.png"));
  await writeFile(banner, "User artwork");
  await writeFile(path, "My edited welcome\n");
  expect(await seedWelcome(config)).toBe(path);
  expect(await readFile(path, "utf8")).toBe("My edited welcome\n");
  expect(await readFile(banner, "utf8")).toBe("User artwork");
  const skills = join(directory, "skills");
  const installed = await installAgentSkill(skills, config);
  expect((await installAgentSkill(skills, config)).installed).toBe(false);
  await writeFile(installed.path, "My review rules\n");
  await expect(installAgentSkill(skills, config)).rejects.toThrow("Existing skill differs");
  expect(await readFile(installed.path, "utf8")).toBe("My review rules\n");
  expect(await readHostPreference(config)).toBe("auto");
  await saveHostPreference(config, "browser");
  expect(await readHostPreference(config)).toBe("browser");
});

test("opted-in skills update across releases, preserve edits, and expose proposals", async () => {
  const { updateAgentSkills, pendingAgentSkillReviews } = await import("../src/cli/agent-skills");
  const { mkdir, symlink } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/tether-skills-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "config") });
  const root = join(directory, "release"), source = join(root, "integrations/agents/tether-review/SKILL.md");
  await mkdir(join(root, "integrations/agents/tether-review"), { recursive: true });
  await writeFile(source, "version one");
  expect(await updateAgentSkills(config, root)).toEqual([]); // No opt-in, no writes.
  expect(await Bun.file(join(config.configDir, "agent-skills.json")).exists()).toBe(false);
  const a = await installAgentSkill(join(directory, "agent-a"), config, root);
  const b = await installAgentSkill(join(directory, "agent-b"), config, root);
  await writeFile(b.path, "personal instructions");
  await writeFile(source, "version two");
  expect(await updateAgentSkills(config, root)).toHaveLength(1);
  expect(await readFile(a.path, "utf8")).toBe("version two");
  expect(await readFile(b.path, "utf8")).toBe("personal instructions");
  const [review] = await pendingAgentSkillReviews(config);
  expect(review!.path).toBe(b.path);
  expect(await readFile(review!.proposal, "utf8")).toBe("version two");
  expect(await updateAgentSkills(config, root)).toHaveLength(1);
  await writeFile(b.path, "version two"); // User approves replacement.
  expect(await pendingAgentSkillReviews(config)).toEqual([]);
  expect(await updateAgentSkills(config, root)).toEqual([]);
  await writeFile(source, "version three");
  expect(await updateAgentSkills(config, root)).toEqual([]);
  expect(await readFile(b.path, "utf8")).toBe("version three");
  await rm(a.path);
  await writeFile(source, "version four");
  await updateAgentSkills(config, root);
  expect(await Bun.file(a.path).exists()).toBe(false); // Removed skills stay removed.
  const target = join(directory, "unrelated.md");
  await writeFile(target, "version four");
  await rm(b.path); await symlink(target, b.path);
  await writeFile(source, "version five");
  expect(await updateAgentSkills(config, root)).toHaveLength(1);
  expect(await readFile(target, "utf8")).toBe("version four");
});

test("packaged skill updater refreshes an opted-in installation", async () => {
  const { mkdir } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/tether-skill-package-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "config") });
  const root = join(directory, "release"), source = join(root, "integrations/agents/tether-review/SKILL.md");
  await mkdir(join(root, "integrations/agents/tether-review"), { recursive: true });
  await writeFile(source, "old bundled skill");
  const installed = await installAgentSkill(join(directory, "skills"), config, root);
  await writeFile(source, "new bundled skill");
  const build = await Bun.build({ entrypoints: ["scripts/update-agent-skills.ts"], target: "bun", outdir: join(root, "lib"), naming: "update-agent-skills.js" });
  expect(build.success).toBe(true);
  const child = Bun.spawn([process.execPath, join(root, "lib/update-agent-skills.js")], {
    env: { ...process.env, TETHER_INSTALL_ROOT: root, TETHER_CONFIG_DIR: config.configDir }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(await readFile(installed.path, "utf8")).toBe("new bundled skill");
});
