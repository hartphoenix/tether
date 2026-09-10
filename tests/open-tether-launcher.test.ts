import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

test("Finder launcher resolves its checkout and Bun before opening Folio", async () => {
  const path = join(import.meta.dir, "..", "Open Tether.command");
  const [source, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  expect(metadata.mode & 0o111).not.toBe(0);
  expect(source).toContain("${HOME}/.bun/bin/bun");
  expect(source).toContain('launcher_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"');
  expect(source).toContain('exec "${launcher_dir}/mdreview" folio');
});
