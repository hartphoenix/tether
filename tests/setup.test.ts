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
  await writeFile(path, "My edited welcome\n");
  expect(await seedWelcome(config)).toBe(path);
  expect(await readFile(path, "utf8")).toBe("My edited welcome\n");
  const skills = join(directory, "skills");
  const installed = await installAgentSkill(skills);
  expect((await installAgentSkill(skills)).installed).toBe(false);
  await writeFile(installed.path, "My review rules\n");
  await expect(installAgentSkill(skills)).rejects.toThrow("Existing skill differs");
  expect(await readFile(installed.path, "utf8")).toBe("My review rules\n");
  expect(await readHostPreference(config)).toBe("auto");
  await saveHostPreference(config, "browser");
  expect(await readHostPreference(config)).toBe("browser");
});
