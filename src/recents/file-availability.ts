import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

export type FileIssue = { code: string; message: string };

/** A Folio path is a saved location, not permission to follow a new destination. */
export async function fileIssue(path: string): Promise<FileIssue | null> {
  try {
    if (await realpath(path) !== path) return { code: "folio_path_changed", message: "This document’s saved path now points to a different location." };
    if (!(await stat(path)).isFile()) return { code: "folio_not_file", message: "This document’s saved location is no longer a file." };
    await access(path, constants.R_OK);
    return null;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { code: "folio_file_missing", message: "The file could not be found at its saved location." };
    if (code === "EACCES" || code === "EPERM") return { code: "folio_file_inaccessible", message: "Tether does not have permission to access this file." };
    if (code === "ELOOP") return { code: "folio_path_changed", message: "This document’s saved path contains a broken link loop." };
    return { code: "folio_file_unavailable", message: `The file could not be accessed (${code ?? "unknown error"}).` };
  }
}

export async function requireFolioFile(path: string): Promise<string> {
  const issue = await fileIssue(path);
  if (issue) throw Object.assign(new Error(issue.message), { code: issue.code, status: 409 });
  return path;
}
