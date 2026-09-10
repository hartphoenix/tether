import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importPackageItems, type ValidatedImportItem } from "../src/documents/package-import";
import { PrivateStore } from "../src/storage/private-store";
import { bodyRevision } from "../src/core/index";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

test("partial package imports report every item and replay successful items across restart", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-package-partial-"));
  directories.push(directory);
  const destination = join(directory, "docs");
  const database = join(directory, "store.sqlite");
  let store = new PrivateStore(database);
  const items: ValidatedImportItem[] = ["one.md", "two.md", "three.md"].map((name) => ({ name, body: name, events: [] }));
  // First import succeeds; a different package then collides only on item 2.
  await importPackageItems([items[1]!], destination, store);
  items[1]!.body = "different content";
  const result = await importPackageItems(items, destination, store);
  expect(result.outcome).toBe("partially_applied");
  expect(result.completed.map(({ index }) => index)).toEqual([0, 2]);
  expect(result.failed).toMatchObject([{ index: 1, code: "destination_record_exists" }]);
  expect(await readFile(join(destination, "two.md"), "utf8")).toBe("two.md");
  const before = store.db.query("SELECT COUNT(*) AS count FROM documents").get();
  await writeFile(join(destination, "one.md"), "user edit");
  store.close();
  store = new PrivateStore(database);
  const retried = await importPackageItems(items, destination, store);
  expect(retried.completed.every(({ replayed }) => replayed)).toBe(true);
  expect(await readFile(join(destination, "one.md"), "utf8")).toBe("user edit");
  expect(store.db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual(before);
  store.close();
});

test("package import does not delete occupied files and cleans up failed SQLite writes", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-package-cleanup-"));
  directories.push(directory);
  const store = new PrivateStore(join(directory, "store.sqlite"));
  const occupied = join(directory, "occupied.md");
  await writeFile(occupied, "keep");
  store.db.exec(`CREATE TRIGGER reject_import BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
  const result = await importPackageItems([
    { name: "occupied.md", body: "replace", events: [] },
    { name: "new.md", body: "new", events: [] },
  ], directory, store);
  expect(result.outcome).toBe("not_applied");
  expect(result.failed).toHaveLength(2);
  expect(result.failed[0]?.code).toBe("EEXIST");
  expect(await readFile(occupied, "utf8")).toBe("keep");
  await expect(readFile(join(directory, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.db.query("SELECT * FROM package_import_receipts").all()).toHaveLength(0);
  store.db.exec("DROP TRIGGER reject_import");
  const retried = await importPackageItems([{ name: "new.md", body: "new", events: [] }], directory, store);
  expect(retried.paths).toEqual([await realpath(join(directory, "new.md"))]);
  store.close();
});

test("package replay fingerprints ignore generated annotation IDs but retain reply relationships", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-package-events-"));
  directories.push(directory);
  const store = new PrivateStore(join(directory, "store.sqlite"));
  const item = (id: string): ValidatedImportItem => ({ name: "review.md", body: "Hello", events: [
    { type: "comment", id, seq: 1, actor: "hart", body: "Comment", createdAt: "2026-09-07T00:00:00.000Z", anchor: { exact: "Hello", prefix: "", suffix: "", projectionStart: 0, projectionEnd: 5, bodyRevision: bodyRevision("Hello") } },
    { type: "reply", id: `${id}-reply`, seq: 2, threadId: id, actor: "assistant", body: "Reply", createdAt: "2026-09-07T00:00:00.000Z" },
  ] });
  expect((await importPackageItems([item("first")], directory, store)).outcome).toBe("applied");
  expect((await importPackageItems([item("regenerated")], directory, store)).completed[0]?.replayed).toBe(true);
  expect(store.db.query("SELECT COUNT(*) AS count FROM annotation_events").get()).toEqual({ count: 2 });
  store.close();
});
