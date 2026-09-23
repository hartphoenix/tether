import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";
import { installAgentSkill, updateAgentSkills, listAgentSkillReviews, readAgentSkillReview, decideAgentSkillReview } from "../src/cli/agent-skills";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp("/tmp/tether-skill-review-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  const root = join(directory, "package"), source = join(root, "integrations/agents/tether-review/SKILL.md");
  await mkdir(join(root, "integrations/agents/tether-review"), { recursive: true });
  await writeFile(source, "Bundled one\n");
  const installed = await installAgentSkill(join(directory, "skills"), config, root);
  await writeFile(installed.path, "My custom instructions\n");
  await writeFile(source, "Bundled two\n");
  await writeFile(join(root, "release.json"), JSON.stringify({version:"0.2.0"}));
  await updateAgentSkills(config, root);
  const [entry] = await listAgentSkillReviews(config);
  const review = await readAgentSkillReview(config, entry!.id);
  return { directory, config, root, source, path: installed.path, review };
}

test("keeping a customized skill acknowledges exact proposed content across updater runs", async () => {
  const f = await fixture();
  await decideAgentSkillReview(f.config, { ...f.review, action: "keep" });
  expect(await readFile(f.path, "utf8")).toBe("My custom instructions\n");
  expect(await listAgentSkillReviews(f.config)).toEqual([]);
  expect(await updateAgentSkills(f.config, f.root)).toEqual([]);
  expect(await listAgentSkillReviews(f.config)).toEqual([]);
  await writeFile(f.source, "Bundled three\n"); await updateAgentSkills(f.config, f.root);
  expect((await listAgentSkillReviews(f.config))).toHaveLength(1);
  expect(await readFile(f.path, "utf8")).toBe("My custom instructions\n");
});

test("approving bundled instructions resumes automatic updates and clears proposal files", async () => {
  const f = await fixture();
  await decideAgentSkillReview(f.config, { ...f.review, action: "replace" });
  expect(await readFile(f.path, "utf8")).toBe("Bundled two\n");
  expect(await Bun.file(f.review.proposal).exists()).toBe(false);
  expect(await listAgentSkillReviews(f.config)).toEqual([]);
  await writeFile(f.source, "Bundled three\n"); await updateAgentSkills(f.config, f.root);
  expect(await readFile(f.path, "utf8")).toBe("Bundled three\n");
});

test("a merged candidate needs explicit current approval and remains customized in future updates", async () => {
  const f = await fixture();
  expect(f.review.candidate).toBeNull();
  expect(f.review.mergePrompt).toContain(f.review.candidatePath);
  await expect(decideAgentSkillReview(f.config, { ...f.review, action: "merge" })).rejects.toThrow("prepare a merged candidate");
  await writeFile(f.review.candidatePath, "Bundled two plus my rules\n");
  await expect(decideAgentSkillReview(f.config, { ...f.review, action: "merge" })).rejects.toThrow("changed");
  const refreshed = await readAgentSkillReview(f.config, f.review.id);
  await decideAgentSkillReview(f.config, { ...refreshed, action: "merge" });
  expect(await readFile(f.path, "utf8")).toBe("Bundled two plus my rules\n");
  expect(await listAgentSkillReviews(f.config)).toEqual([]);
  await updateAgentSkills(f.config, f.root);
  expect(await readFile(f.path, "utf8")).toBe("Bundled two plus my rules\n");
  await writeFile(f.source, "Bundled three\n"); await updateAgentSkills(f.config, f.root);
  const next = await readAgentSkillReview(f.config, f.review.id);
  expect(next.candidate).toBeNull();
  expect(next.candidatePath).not.toBe(f.review.candidatePath);
  expect(next.current).toBe("Bundled two plus my rules\n");
});

test("approval rejects changed installed, proposed, or merged content without overwriting edits", async () => {
  const f = await fixture();
  await writeFile(f.path, "New custom edit\n");
  await expect(decideAgentSkillReview(f.config, { ...f.review, action: "replace" })).rejects.toThrow("changed");
  expect(await readFile(f.path, "utf8")).toBe("New custom edit\n");
  let review = await readAgentSkillReview(f.config, f.review.id);
  await writeFile(f.review.proposal, "Changed proposal\n");
  await expect(decideAgentSkillReview(f.config, { ...review, action: "keep" })).rejects.toThrow("changed");
  review = await readAgentSkillReview(f.config, f.review.id);
  await writeFile(review.candidatePath, "Merged draft\n");
  review = await readAgentSkillReview(f.config, f.review.id);
  await writeFile(review.candidatePath, "Changed merged draft\n");
  await expect(decideAgentSkillReview(f.config, { ...review, action: "merge" })).rejects.toThrow("changed");
  expect(await readFile(f.path, "utf8")).toBe("New custom edit\n");
});

test("only registered IDs are readable and review files must be regular bounded files", async () => {
  const f = await fixture();
  await expect(readAgentSkillReview(f.config, f.path)).rejects.toThrow("no longer needs review");
  await expect(decideAgentSkillReview(f.config, { id: f.path, revision: f.review.revision, action: "replace" })).rejects.toThrow();
  await expect(decideAgentSkillReview(f.config, { ...f.review, action: "unknown" })).rejects.toThrow();
  await symlink(f.path, f.review.candidatePath);
  await expect(readAgentSkillReview(f.config, f.review.id)).rejects.toThrow();
  await rm(f.review.candidatePath);
  await writeFile(f.review.candidatePath, "x".repeat(1024 * 1024 + 1));
  await expect(readAgentSkillReview(f.config, f.review.id)).rejects.toThrow("1 MiB");
  expect(await readFile(f.path, "utf8")).toBe("My custom instructions\n");
});


test("agent conversation applies an approved merge and clears review without a browser", async () => {
  const f = await fixture();
  expect(f.review.mergePrompt).toContain("Read the release notes: https://github.com/hartphoenix/tether/releases/tag/v0.2.0");
  expect(f.review.mergePrompt).toContain("clarifying questions");
  expect(f.review.mergePrompt).toContain("obtain my approval here");
  expect(f.review.mergePrompt).toContain("skills merge");
  const candidate = f.review.candidatePath;
  await writeFile(candidate, "Bundled two\nMy preferences\n");
  const args = ["skills", "merge", f.review.id, "--expected-revision", f.review.sourceRevision, "--body-file", candidate];
  expect((await runCli(args, { config: f.config })).exitCode).toBe(2);
  expect(await readFile(f.path, "utf8")).toBe("My custom instructions\n");
  expect((await runCli([...args, "--confirm"], { config: f.config })).exitCode).toBe(0);
  expect(await readFile(f.path, "utf8")).toBe("Bundled two\nMy preferences\n");
  expect(await listAgentSkillReviews(f.config)).toEqual([]);
  await writeFile(f.source, "Bundled three\n"); await updateAgentSkills(f.config, f.root);
  expect(await listAgentSkillReviews(f.config)).toHaveLength(1);
});

test("conversation merge rejects edited sources and exposes a fresh source revision", async () => {
  const f = await fixture();
  await writeFile(f.review.candidatePath, "Merged\n");
  await writeFile(f.path, "Changed since the conversation started\n");
  const result = await runCli(["skills", "merge", f.review.id, "--expected-revision", f.review.sourceRevision, "--body-file", f.review.candidatePath, "--confirm"], { config: f.config });
  expect(result.exitCode).toBe(1);
  expect(await readFile(f.path, "utf8")).toBe("Changed since the conversation started\n");
  expect((await runCli(["skills", "read", f.review.id], { config: f.config })).exitCode).toBe(0);
  expect((await readAgentSkillReview(f.config, f.review.id)).sourceRevision).not.toBe(f.review.sourceRevision);
});
