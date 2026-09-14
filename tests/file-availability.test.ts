import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileIssue } from "../src/recents/file-availability";

test("availability distinguishes missing, invalid, unreadable and redirected files without rejecting atomic saves", async () => {
  const temporary = await mkdtemp("/tmp/tether-availability-");
  const directory = await realpath(temporary), path = join(directory, "file.md");
  try {
    expect((await fileIssue(path))?.code).toBe("folio_file_missing");
    await mkdir(path); expect((await fileIssue(path))?.code).toBe("folio_not_file"); await rm(path, { recursive: true });
    await symlink(join(directory, "absent"), path); expect((await fileIssue(path))?.code).toBe("folio_file_missing"); await rm(path);
    await symlink(path, path); expect((await fileIssue(path))?.code).toBe("folio_path_changed"); await rm(path);
    await writeFile(path, "First"); expect(await fileIssue(path)).toBeNull();
    await chmod(path, 0);
    try { if (process.getuid?.() !== 0) expect((await fileIssue(path))?.code).toBe("folio_file_inaccessible"); }
    finally { await chmod(path, 0o600); }
    const next = join(directory, "next.md"); await writeFile(next, "Second"); await rename(next, path);
    expect(await fileIssue(path)).toBeNull();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
