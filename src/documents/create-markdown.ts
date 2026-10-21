import { link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { invalidRequest } from "../shared/control-input";

export async function creationPath(path: unknown): Promise<string> {
  if (typeof path !== "string" || ![".md", ".markdown"].includes(extname(path).toLowerCase())) throw invalidRequest("A new .md or .markdown path is required.");
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

/** Publish complete bytes without ever replacing an existing file or symlink. */
export async function createMarkdown(path: string, body: string): Promise<void> {
  const temporary = join(dirname(path), `.tether-create-${crypto.randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
    try { await link(temporary, path); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("The destination exists. Creation never overwrites or claims an existing document; use document read or a Go assignment prompt."), { code: "document_exists", status: 409 });
      throw cause;
    }
  } finally { await file.close(); await unlink(temporary); }
}
