import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeRoot } from "../runtime-paths";
import type { TetherConfig } from "../server/config";
export { seedWelcome } from "../onboarding";

export type HostPreference = "auto" | "browser" | "wave" | "cmux";
export function hostPreference(value: string): HostPreference {
  if (!["auto", "browser", "wave", "cmux"].includes(value)) throw new Error("Host must be auto, browser, wave, or cmux.");
  return value as HostPreference;
}
export async function readHostPreference(config: TetherConfig): Promise<HostPreference> {
  try { return hostPreference(JSON.parse(await readFile(join(config.configDir, "launch.json"), "utf8")).host); }
  catch { return "auto"; }
}
export async function saveHostPreference(config: TetherConfig, host: HostPreference): Promise<void> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  const path = join(config.configDir, "launch.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ host }) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
export async function installAgentSkill(directory: string): Promise<{ path: string; installed: boolean }> {
  const destination = resolve(directory, "tether-review");
  await mkdir(destination, { recursive: true });
  const source = join(runtimeRoot(), "integrations/agents/tether-review/SKILL.md");
  const path = join(destination, "SKILL.md");
  try { await copyFile(source, path, constants.COPYFILE_EXCL); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    if (await readFile(source, "utf8") !== await readFile(path, "utf8")) throw new Error(`Existing skill differs; review it before updating: ${path}`);
    return { path, installed: false };
  }
  return { path, installed: true };
}
