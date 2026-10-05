/** Register the local Paseo service without replacing unrelated workspace settings. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
export const phoneStageService = { type: "service", command: "exec bun scripts/phone-reader-stage.ts" };
export async function setupPhoneStage(directory: string, folioProfile?: string) {
  if (folioProfile && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folioProfile)) throw new Error("Invalid Folio profile.");
  const path = join(directory, "paseo.json");
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; });
  const config = JSON.parse(source);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Expected a Paseo configuration object.");
  if (config.scripts !== undefined && (!config.scripts || typeof config.scripts !== "object" || Array.isArray(config.scripts))) throw new Error("Expected a Paseo scripts object.");
  const previous = config.scripts?.phone;
  if (previous && (previous.type !== "service" || ![phoneStageService.command, "bun run stage:phone"].includes(previous.command) && !/^exec bun scripts\/phone-reader-stage\.ts --folio-profile [A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(previous.command))) throw new Error("A different phone script already exists; leaving it unchanged.");
  config.scripts = { ...config.scripts, phone: { ...previous, ...phoneStageService, command: folioProfile ? `${phoneStageService.command} --folio-profile ${folioProfile}` : previous?.command?.includes("--folio-profile") ? previous.command : phoneStageService.command } };
  const temporary = `${path}.phone-stage-${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n");
  await rename(temporary, path);
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--folio-profile")) throw new Error("Expected --folio-profile PROFILE");
  await setupPhoneStage(resolve(import.meta.dir, ".."), args[1]);
  console.log("Paseo phone service configured. Start phone from the workspace scripts.");
}
