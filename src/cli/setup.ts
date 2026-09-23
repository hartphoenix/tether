import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
export { installAgentSkill } from "./agent-skills";
import type { TetherConfig } from "../server/config";
export { seedWelcome } from "../onboarding";

export type HostPreference = "auto" | "browser" | "wave" | "cmux";
export function hostPreference(value: string): HostPreference {
  if (!["auto", "browser", "wave", "cmux"].includes(value)) throw new Error("Host must be auto, browser, wave, or cmux.");
  return value as HostPreference;
}
export async function readHostPreference(config: TetherConfig): Promise<HostPreference> {
  try { return hostPreference(JSON.parse(await readFile(join(config.configDir, "launch.json"), "utf8")).host); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "auto"; throw cause; }
}
export async function saveHostPreference(config: TetherConfig, host: HostPreference): Promise<void> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  const path = join(config.configDir, "launch.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ host }) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export const agentSetupGuidance = "Ask whether the user wants the optional Tether review skill, which stays current with package updates. After consent, identify your own skills directory and run tether setup --agent-directory <skills-directory> --no-open for them. Ask if the directory is uncertain; do not guess. Customized skills are preserved for review during updates. Do not ask again if the user already accepted or declined in this setup.";
