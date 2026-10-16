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

async function runtimeVersion(): Promise<string | null> {
  for (const name of ["release.json", "package.json"]) {
    try { return JSON.parse(await readFile(join(runtimeRoot(), name), "utf8")).version ?? null; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  return null;
}

/** The current release's notes, copied beside the welcome document; null when not bundled. */
export async function releaseNotesDocument(config: TetherConfig): Promise<{ source: string; path: string; version: string } | null> {
  const version = await runtimeVersion();
  if (!version) return null;
  const source = join(runtimeRoot(), "docs/releases", `${version}.md`);
  if (!await Bun.file(source).exists()) return null;
  return { source, path: join(config.configDir, "documents", `Tether ${version} release notes.md`), version };
}

export async function seedReleaseNotes(config: TetherConfig): Promise<string | null> {
  const notes = await releaseNotesDocument(config);
  if (!notes) return null;
  const template = await readFile(notes.source, "utf8");
  const directory = join(config.configDir, "documents");
  await mkdir(join(directory, "assets"), { recursive: true, mode: 0o700 });
  for (const [, name] of template.matchAll(/\]\(\.\.\/assets\/([\w.-]+)(?:#[\w-]+)?\)/g)) {
    try { await copyFile(join(runtimeRoot(), "docs/assets", name!), join(directory, "assets", name!), constants.COPYFILE_EXCL); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  }
  // The copy sits beside the welcome document, so relative links follow it there.
  const body = template.replaceAll("](../assets/", "](assets/").replaceAll("[[../getting-started.md|", "[[Getting started with Tether.md|").replaceAll("[[../getting-started.md|", "[[Getting started with Tether.md|");
  try { await writeFile(notes.path, body, { flag: "wx", mode: 0o600 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  return notes.path;
}
