import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrivateStore, PrivateStoreConflictError } from "../src/storage/index";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("PrivateStore Folio operations", () => {
  test("shares settings, locates a conversation, and deletes only private conversation data", async () => {
    const directory = await mkdtemp(join("/tmp", "tether-store-")); directories.push(directory);
    const oldFile = join(directory, "old.md"); const newFile = join(directory, "new.md"); await writeFile(oldFile, "Old\n"); await writeFile(newFile, "New\n");
    const oldPath = await realpath(oldFile); const newPath = await realpath(newFile); const store = new PrivateStore(join(directory, "tether.sqlite"));
    store.ensureDocument(oldPath, 1); store.db.query("INSERT INTO settings(key,value) VALUES (?,?)").run("archive_retention", "30");
    expect(store.db.query("SELECT value FROM settings WHERE key = ?").get("archive_retention")).toEqual({ value: "30" });
    expect(store.locate(oldPath, newPath).path).toBe(newPath); expect(store.documentForPath(oldPath)).toBeNull();
    expect(store.deleteConversation(newPath)).toBe(true); expect(store.documentForPath(newPath)).not.toBeNull(); store.close();
  });

  test("rejects locate when the destination already has a record", async () => {
    const store = new PrivateStore(); store.ensureDocument("/tmp/a.md", 1); store.ensureDocument("/tmp/b.md", 1);
    expect(() => store.locate("/tmp/a.md", "/tmp/b.md")).toThrow(PrivateStoreConflictError); store.close();
  });

  test("read helpers and stale mutations never recreate a deleted document row", () => {
    const store = new PrivateStore(); const path = "/tmp/deleted.md"; store.ensureDocument(path, 1);
    store.db.query("DELETE FROM documents WHERE path = ?").run(path);
    expect(() => store.ledger(path, "sha256:" + "0".repeat(64))).toThrow("private document record no longer exists");
    expect(() => store.observe(path, "assistant", 0, "sha256:" + "0".repeat(64))).toThrow("private document record no longer exists");
    expect(store.documentForPath(path)).toBeNull(); store.close();
  });
});
