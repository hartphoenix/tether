import { open, link, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Bound allocation while reading either a file or stdin. */
export async function readBoundedInput(path: string, limit: number): Promise<string> {
  const stream = path === "-" ? Bun.stdin.stream() : Bun.file(resolve(path)).stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Object.assign(new Error(`Input exceeds ${limit} bytes.`), { code: "input_too_large" });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Publish complete private packages; no-clobber remains atomic at publication. */
export async function writeExport(destination: string, text: string, overwrite = false): Promise<void> {
  const temporary = join(dirname(destination), `.${basename(destination)}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    if (overwrite) await rename(temporary, destination);
    else await link(temporary, destination);
    const directory = await open(dirname(destination), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("Export destination exists. Choose another path or use --overwrite."), { code: "destination_exists" });
    throw cause;
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
