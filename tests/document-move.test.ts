import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocumentService } from "../src/documents/document-service";
import { PrivateStore } from "../src/storage/private-store";
import { ViewStore } from "../src/server/view-store";
import { withPathLock } from "../src/documents/path-lock";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tether-move-")); roots.push(root);
  const path = join(root, "source.md"); await writeFile(path, "# Title\nBody\n");
  const store = new PrivateStore(join(root, "private.sqlite"));
  const service = new DocumentService({ store }); const session = await service.open(path);
  const doc = await service.read(session);
  await service.appendComment({ session, actor: "hart", body: "Keep me", operationId: "seed", expectedBodyRevision: doc.bodyRevision, anchor: { exact: "Title", prefix: "", suffix: "", projectionStart: 0, projectionEnd: 5, bodyRevision: doc.bodyRevision } });
  return { root, path, target: join(root, "moved.md"), store, service, session };
}

test("move preserves conversation, receipts, acknowledgements, Folio state and live/persisted views", async () => {
  const f = await fixture(); const views = new ViewStore(f.store.db);
  views.put({ id: "view", kind: "document", path: f.path, verifier: "hash", createdAt: 1 });
  views.saveDraft("view", { body: "Unsaved", baseRevision: "rev", scroll: 2, updatedAt: 1 });
  f.store.db.query("UPDATE documents SET pinned=1 WHERE path=?").run(f.path);
  const id = f.store.documentForPath(f.path)!.id;
  const pending = await f.service.pending(f.session);
  await f.service.acknowledge({ session: f.session, actor: "assistant", cursor: pending.cursor, operationId: "seen" });
  expect(await f.service.move(f.path, f.target)).toMatchObject({ path: f.target, documentId: id, outcome: "applied" });
  expect(f.store.documentForPath(f.path)).toBeNull();
  expect(f.store.documentForPath(f.target)).toMatchObject({ id, active: 1, pinned: 1 });
  expect((await f.service.read(f.session)).path).toBe(f.target);
  expect(f.store.events(f.target)).toHaveLength(1);
  expect(f.store.acknowledgement(f.target, "assistant")).not.toBeNull();
  expect(f.store.lookupMutation(f.target, "seed").outcome).toBe("applied");
  expect(views.list()[0]!.path).toBe(f.target); expect(views.draft("view")!.body).toBe("Unsaved");
  expect(await readFile(f.target, "utf8")).toBe("# Title\nBody\n");
  expect(await Bun.file(f.path).exists()).toBe(false); f.store.close();
});

test("move refuses collisions, identical paths and unknown conversations without modifying files", async () => {
  const f = await fixture(); await writeFile(f.target, "Occupied");
  await expect(f.service.move(f.path, f.target)).rejects.toBeTruthy();
  expect(await readFile(f.target, "utf8")).toBe("Occupied");
  await expect(f.service.move(f.path, f.path)).rejects.toBeTruthy();
  const unknown = join(f.root, "unknown.md"); await writeFile(unknown, "Unknown");
  await expect(f.service.move(unknown, join(f.root, "new.md"))).rejects.toBeTruthy();
  expect(f.store.documentForPath(unknown)).toBeNull(); f.store.close();
});

test("move journal resumes before link, after link, and after SQLite path commit", async () => {
  for (const phase of [0, 1, 2]) {
    const f = await fixture(); const info = await stat(f.path); const id = f.store.documentForPath(f.path)!.id;
    f.store.db.query("INSERT INTO document_moves VALUES (?,?,?,?,?,?)").run("interrupted", id, f.path, f.target, info.dev, info.ino);
    if (phase > 0) await link(f.path, f.target);
    if (phase > 1) f.store.db.query("UPDATE documents SET path=? WHERE id=?").run(f.target, id);
    f.store.close();
    const store = new PrivateStore(join(f.root, "private.sqlite")); const service = new DocumentService({ store });
    await service.recoverMoves();
    expect(store.documentForPath(f.target)!.id).toBe(id); expect(store.events(f.target)).toHaveLength(1);
    expect(await Bun.file(f.path).exists()).toBe(false); expect(await Bun.file(f.target).exists()).toBe(true);
    expect(store.db.query("SELECT * FROM document_moves").all()).toHaveLength(0); store.close();
  }
});

test("existing grants reject symlinks and parent replacement but accept ordinary editor atomic saves", async () => {
  const f = await fixture(); const unrelated = join(f.root, "unrelated.md"); await writeFile(unrelated, "Private unrelated content");
  await unlink(f.path); await symlink(unrelated, f.path);
  await expect(f.service.read(f.session)).rejects.toBeTruthy();
  await unlink(f.path); const replacement = join(f.root, "replacement.md"); await writeFile(replacement, "Editor replacement"); await rename(replacement, f.path);
  expect((await f.service.read(f.session)).body).toBe("Editor replacement");
  const subdir = join(f.root, "docs"); await mkdir(subdir); const nested = join(subdir, "nested.md"); await writeFile(nested, "Original"); const nestedSession = await f.service.open(nested);
  await rename(subdir, join(f.root, "old-docs")); await mkdir(subdir); await writeFile(nested, "Redirected");
  await expect(f.service.read(nestedSession)).rejects.toBeTruthy(); f.store.close();
});

test("cooperating writer conflicts are explicit and locks release after failures", async () => {
  const f = await fixture();
  await withPathLock(f.path, async () => { await expect(withPathLock(f.path, async () => {})).rejects.toMatchObject({ code: "writer_busy" }); });
  await expect(withPathLock(f.path, async () => { throw new Error("test"); })).rejects.toThrow("test");
  await withPathLock(f.path, async () => {}); f.store.close();
});

test("kernel writer locks survive differing TMPDIRs and release when a writer is killed", async () => {
  const f = await fixture();
  const module = new URL("../src/documents/path-lock.ts", import.meta.url).pathname;
  const script = `import { withPathLock } from ${JSON.stringify(module)}; await withPathLock(${JSON.stringify(f.path)}, async () => { console.log('locked'); await new Promise(() => setInterval(() => {}, 1000)); });`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, TMPDIR: f.root }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked"); reader.releaseLock();
    await expect(withPathLock(f.path, async () => {})).rejects.toMatchObject({ code: "writer_busy" });
    child.kill(9); await child.exited;
    await withPathLock(f.path, async () => {});
  } finally { child.kill(); await child.exited; f.store.close(); }
});
