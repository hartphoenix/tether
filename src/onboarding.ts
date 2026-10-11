import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { runtimeRoot } from "./runtime-paths";
import type { TetherConfig } from "./server/config";

/** An explicit setup/help action creates one user-owned practice document. */
export async function seedWelcome(config: TetherConfig): Promise<string> {
  const directory = join(config.configDir, "documents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "assets"), { recursive: true, mode: 0o700 });
  for (const banner of ["tether-banner-dark.webp", "tether-banner-light.webp"]) {
    try { await copyFile(join(runtimeRoot(), "docs/assets", banner), join(directory, "assets", banner), constants.COPYFILE_EXCL); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  }
  const path = join(directory, "Getting started with Tether.md");
  const template = await readFile(join(runtimeRoot(), "docs/getting-started.md"), "utf8");
  try { await writeFile(path, template.replaceAll("{{DOCUMENT_PATH}}", path), { flag: "wx", mode: 0o600 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  return path;
}
