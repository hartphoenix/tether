import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { INPUT_LIMITS } from "../shared/control-input";

export type DirectoryIdentity = { dev: number; ino: number };
export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await stat(dirname(path));
  return { dev: info.dev, ino: info.ino };
}
export function pathChanged(): Error {
  return Object.assign(new Error("The document path changed. Reopen the intended file."), { code: "path_changed", status: 409 });
}

/** Pin the opened file, reject symlinks, and check the granted parent before returning bytes. */
export async function readSafe(path: string, parent?: DirectoryIdentity): Promise<string> {
  if (await realpath(path) !== path) throw pathChanged();
  const directory = await directoryIdentity(path);
  if (parent && (parent.dev !== directory.dev || parent.ino !== directory.ino)) throw pathChanged();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw pathChanged();
    if (before.size > INPUT_LIMITS.markdown) throw Object.assign(new Error("Markdown exceeds the 16 MiB read limit."), { code: "input_too_large", status: 413 });
    const value = await handle.readFile("utf8");
    const after = await handle.stat();
    const current = await stat(path);
    const finalDirectory = await directoryIdentity(path);
    if (await realpath(path) !== path || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || directory.dev !== finalDirectory.dev || directory.ino !== finalDirectory.ino) throw pathChanged();
    return value;
  } finally { await handle.close(); }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
