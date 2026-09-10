import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision, validateAnnotationEvent } from "../src/core/index";
import { DocumentAccessError, DocumentConflictError, DocumentService, PrivateStore, RealPathMutationQueue } from "../src/documents/index";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(source = "Hello world\n") {
  const directory = await mkdtemp(join("/tmp", "tether-documents-")); directories.push(directory);
  const path = join(directory, "example.md"); await writeFile(path, source); return { directory, path };
}
function anchor(revision: string) {
  return { exact: "Hello", prefix: "", suffix: " world", projectionStart: 0, projectionEnd: 5, bodyRevision: revision };
}

describe("DocumentService grants and body writes", () => {
  test("grants only an explicitly opened canonical Markdown path", async () => {
    const file = await fixture(); const other = join(file.directory, "other.md"); await writeFile(other, "Other\n");
    const service = new DocumentService(); const session = await service.open(file.path);
    expect(session.path).toBe(await realpath(file.path)); expect((await service.read(session)).body).toBe("Hello world\n");
    await expect(service.read(other)).rejects.toBeInstanceOf(DocumentAccessError);
    await expect(service.read({ ...session, sessionId: crypto.randomUUID(), id: "bad" })).rejects.toBeInstanceOf(DocumentAccessError);
  });

  test("writes clean exact Markdown and rechecks external edits", async () => {
    const file = await fixture("Body\n"); await chmod(file.path, 0o640);
    const service = new DocumentService(); const session = await service.open(file.path); const initial = await service.read(session);
    await writeFile(file.path, "External\n");
    await expect(service.saveBody({ session, body: "Changed\n", expectedBodyRevision: initial.bodyRevision })).rejects.toBeInstanceOf(DocumentConflictError);
    const external = await service.read(session);
    const saved = await service.saveBody({ session, body: "Changed\n", expectedBodyRevision: external.bodyRevision });
    expect(saved.body).toBe("Changed\n"); expect(await readFile(file.path, "utf8")).toBe("Changed\n"); expect((await stat(file.path)).mode & 0o777).toBe(0o640);
  });

  test("does not overwrite an external write that lands after the temporary file is complete", async () => {
    const file = await fixture("Original\n");
    const service = new DocumentService({ beforeBodyReplace: async (path) => { await writeFile(path, "External writer\n"); } });
    const session = await service.open(file.path); const initial = await service.read(session);
    await expect(service.saveBody({ session, body: "Tether edit\n", expectedBodyRevision: initial.bodyRevision })).rejects.toBeInstanceOf(DocumentConflictError);
    expect(await readFile(file.path, "utf8")).toBe("External writer\n");
  });
});

describe("private review storage", () => {
  test("open, comment, reply, and acknowledge never alter Markdown bytes or mtime", async () => {
    const file = await fixture(); const database = join(file.directory, "tether.sqlite");
    const before = await stat(file.path); const service = new DocumentService({ storePath: database }); const session = await service.open(file.path);
    const initial = await service.read(session);
    const comment = await service.appendComment({ session, actor: "hart", body: "Clarify.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "comment-1" });
    const threadId = (comment.annotations.events[0] as { id: string }).id;
    await service.reply({ session, actor: "assistant", threadId, body: "Done.", operationId: "reply-1" });
    const pending = await service.pending(session, "assistant", "review-bot");
    await service.acknowledge({ session, actor: "assistant", consumer: "review-bot", cursor: pending.cursor, operationId: "ack-1" });
    const after = await stat(file.path);
    expect(await readFile(file.path, "utf8")).toBe("Hello world\n"); expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.size).toBe(before.size);
  });

  test("persists private conversations across a service restart", async () => {
    const file = await fixture(); const database = join(file.directory, "tether.sqlite");
    let store = new PrivateStore(database); let service = new DocumentService({ store }); let session = await service.open(file.path); const initial = await service.read(session);
    const written = await service.appendComment({ session, actor: "hart", body: "Persist me.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "persist-1" });
    const id = (written.annotations.events[0] as { id: string }).id; store.close();
    store = new PrivateStore(database); service = new DocumentService({ store }); session = await service.open(file.path);
    expect((await service.thread(session, id)).thread.comment.body).toBe("Persist me."); expect(await readFile(file.path, "utf8")).toBe("Hello world\n"); store.close();
  });

  test("an in-flight read cannot recreate a document record deleted after its grant check", async () => {
    const file = await fixture(); let releaseRead!: () => void; let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const service = new DocumentService({ readText: async (path) => { markReadStarted(); await readGate; return readFile(path, "utf8"); } });
    const session = await service.open(file.path); const reading = service.read(session); await readStarted;
    await service.deleteConversation(session.path); service.store.db.query("DELETE FROM documents WHERE path = ?").run(session.path);
    releaseRead();
    await expect(reading).rejects.toBeInstanceOf(DocumentAccessError);
    expect(service.store.documentForPath(session.path)).toBeNull();
  });

  test("a save authorized before queued deletion cannot run afterward or recreate storage", async () => {
    class ObservedQueue extends RealPathMutationQueue {
      onEnqueued = () => {};
      override run<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
        const result = super.run(path, operation);
        this.onEnqueued();
        return result;
      }
    }
    const queue = new ObservedQueue();
    const file = await fixture(); const service = new DocumentService({ queue }); const session = await service.open(file.path); const initial = await service.read(session);
    let releaseQueue!: () => void; const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const blocker = service.queue.run(session.path, async () => { await queueGate; });
    const deletionQueued = new Promise<void>(resolve => { queue.onEnqueued = resolve; });
    const deleting = service.deleteConversation(session.path); await deletionQueued;
    const saveQueued = new Promise<void>(resolve => { queue.onEnqueued = resolve; });
    const saving = service.saveBody({ session, body: "Stale queued save\n", expectedBodyRevision: initial.bodyRevision }); await saveQueued;
    releaseQueue(); await blocker; await deleting;
    service.store.db.query("DELETE FROM documents WHERE path = ?").run(session.path);
    await expect(saving).rejects.toBeInstanceOf(DocumentAccessError);
    expect(await readFile(file.path, "utf8")).toBe("Hello world\n"); expect(service.store.documentForPath(session.path)).toBeNull();
  });

  test("replays identical operation IDs and conflicts on changed payloads", async () => {
    const file = await fixture(); const service = new DocumentService(); const session = await service.open(file.path); const initial = await service.read(session);
    const input = { session, actor: "hart", body: "Once.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "stable-id" };
    const first = await service.appendComment(input); const replay = await service.appendComment(input);
    expect(replay.mutation).toEqual({ ...first.mutation, replayed: true }); expect(replay.annotations.events).toHaveLength(1);
    await expect(service.appendComment({ ...input, body: "Different." })).rejects.toBeInstanceOf(DocumentConflictError);
  });

  test("finds a comment receipt from its stable caller payload before deriving a new anchor", async () => {
    const file = await fixture(); const service = new DocumentService(); const session = await service.open(file.path); const initial = await service.read(session);
    const request = { type: "comment", actor: "hart", body: "Once.", quote: "Hello" };
    const first = await service.appendComment({ session, actor: "hart", body: "Once.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "quoted-comment", requestFingerprint: request });
    await writeFile(file.path, "The original quote is gone.\n");
    const replay = await service.mutationReceipt(session, "quoted-comment", request);
    expect(replay?.mutation).toEqual({ ...first.mutation, replayed: true });
    await expect(service.mutationReceipt(session, "quoted-comment", { ...request, quote: "different" })).rejects.toBeInstanceOf(DocumentConflictError);
  });

  test("uses consumer-specific opaque cursors, including an empty observation", async () => {
    const file = await fixture(); const service = new DocumentService(); const session = await service.open(file.path);
    const empty = await service.pending(session, "assistant", "worker-a"); expect(empty.events).toHaveLength(0); expect(empty.cursor).toMatch(/^r-/);
    await service.acknowledge({ session, actor: "assistant", consumer: "worker-a", cursor: empty.cursor, operationId: "ack-empty" });
    const initial = await service.read(session);
    await service.appendComment({ session, actor: "hart", body: "New.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "new-comment" });
    expect((await service.pending(session, "assistant", "worker-a")).events).toHaveLength(1);
    expect((await service.pending(session, "assistant", "worker-b")).events).toHaveLength(1);
    await expect(service.acknowledge({ session, actor: "assistant", consumer: "worker-b", cursor: empty.cursor, operationId: "wrong-consumer" })).rejects.toBeInstanceOf(DocumentConflictError);
  });

  test("reports when the Markdown body changed after a consumer acknowledged it", async () => {
    const file = await fixture(); const service = new DocumentService(); const session = await service.open(file.path);
    const pending = await service.pending(session, "assistant");
    await service.acknowledge({ session, actor: "assistant", cursor: pending.cursor, operationId: "body-ack" });
    expect((await service.pending(session, "assistant")).bodyChangedSinceAck).toBe(false);
    await service.saveBody({ session, body: "Changed after review\n", expectedBodyRevision: pending.bodyRevision });
    expect((await service.pending(session, "assistant")).bodyChangedSinceAck).toBe(true);
  });

  test("checks a thread's expected latest sequence", async () => {
    const file = await fixture(); const service = new DocumentService(); const session = await service.open(file.path); const initial = await service.read(session);
    const comment = await service.appendComment({ session, actor: "hart", body: "Thread.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "c" });
    const threadId = (comment.annotations.events[0] as { id: string }).id;
    await service.reply({ session, actor: "assistant", threadId, body: "Reply.", expectedThreadSequence: 1, operationId: "r" });
    await expect(service.resolve({ session, actor: "hart", threadId, expectedThreadSequence: 1, operationId: "stale" })).rejects.toBeInstanceOf(DocumentConflictError);
    expect((await service.resolve({ session, actor: "hart", threadId, expectedThreadSequence: 2, operationId: "current" })).annotations.threads[0]).toMatchObject({ status: "resolved" });
  });

  test("exports only displayed unresolved content and imports it without absolute paths or history", async () => {
    const first = await fixture(); const service = new DocumentService(); const session = await service.open(first.path); const initial = await service.read(session);
    const comment = await service.appendComment({ session, actor: "hart", body: "Old secret text.", anchor: anchor(initial.bodyRevision), expectedBodyRevision: initial.bodyRevision, operationId: "ec" });
    const threadId = (comment.annotations.events[0] as { id: string }).id;
    await service.edit({ session, actor: "hart", threadId, targetId: threadId, body: "Current text.", operationId: "ee" });
    const reply = await service.reply({ session, actor: "assistant", threadId, body: "Remove this reply.", operationId: "er" });
    const replyId = (reply.annotations.events[2] as { id: string }).id;
    await service.delete({ session, actor: "assistant", threadId, targetId: replyId, operationId: "ed" });
    const exported = await service.exportReviews([session]); const encoded = JSON.stringify(exported);
    expect(encoded).toContain("Current text."); expect(encoded).not.toContain("Old secret text."); expect(encoded).not.toContain("Remove this reply."); expect(encoded).not.toContain(first.directory); expect(encoded).not.toContain("latestEvent");
    const destination = join(first.directory, "imported"); const paths = await service.importReviews(exported, destination);
    const imported = await service.open(paths[0]); const importedThreads = await service.threads(imported);
    expect(importedThreads.threads[0]).toMatchObject({ status: "open", comment: { actor: "hart", body: "Current text." }, replies: [] });
  });

  test("suffixes exported basenames case-insensitively so its own package can import", async () => {
    const directory = await mkdtemp(join("/tmp", "tether-export-names-")); directories.push(directory);
    const leftDirectory = join(directory, "left"); const rightDirectory = join(directory, "right");
    await Promise.all([mkdir(leftDirectory), mkdir(rightDirectory)]);
    const upper = join(leftDirectory, "Example.md"); const lower = join(rightDirectory, "example.md"); await writeFile(upper, "Upper\n"); await writeFile(lower, "Lower\n");
    const service = new DocumentService(); const upperSession = await service.open(upper); const lowerSession = await service.open(lower);
    const exported = await service.exportReviews([upperSession, lowerSession]);
    expect(exported.documents.map((item) => item.name)).toEqual(["Example.md", "example (2).md"]);
    const imported = await service.importReviews(exported, join(directory, "destination"));
    expect(imported).toHaveLength(2); expect(await readFile(imported[0], "utf8")).toBe("Upper\n"); expect(await readFile(imported[1], "utf8")).toBe("Lower\n");
  });

  test("preserves an existing destination file when package import collides", async () => {
    const source = await fixture("Package body\n"); const service = new DocumentService(); const session = await service.open(source.path);
    const exported = await service.exportReviews([session]); const destination = join(source.directory, "collision");
    await mkdir(destination);
    const existing = join(destination, "example.md"); await writeFile(existing, "Keep this\n");
    await expect(service.importReviews(exported, destination)).rejects.toBeTruthy();
    expect(await readFile(existing, "utf8")).toBe("Keep this\n");
  });

  test("preserves a missing file's existing private conversation when import targets its path", async () => {
    const source = await fixture("Package body\n"); const service = new DocumentService(); const session = await service.open(source.path);
    const exported = await service.exportReviews([session]); const destination = join(source.directory, "missing-record");
    await mkdir(destination);
    const target = join(await realpath(destination), "example.md"); service.store.ensureDocument(target, 1);
    const existingEvent = validateAnnotationEvent({ type: "comment", id: "existing", seq: 1, actor: "hart", createdAt: "now", body: "Existing private conversation", anchor: anchor(bodyRevision("Absent\n")) });
    service.store.replaceEvents(target, [existingEvent], 1);
    await expect(service.importReviews(exported, destination)).rejects.toBeInstanceOf(DocumentConflictError);
    expect(service.store.events(target)).toEqual([existingEvent]);
    await expect(readFile(target, "utf8")).rejects.toBeTruthy();
  });
});

describe("RealPathMutationQueue", () => {
  test("serializes one path and allows another path concurrently", async () => {
    const queue = new RealPathMutationQueue(); let active = 0; let maximum = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("/tmp/one.md", async () => { active++; maximum = Math.max(maximum, active); await gate; active--; });
    const second = queue.run("/tmp/one.md", async () => { active++; maximum = Math.max(maximum, active); active--; });
    const third = queue.run("/tmp/two.md", async () => { active++; maximum = Math.max(maximum, active); active--; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(active).toBe(1); release(); await Promise.all([first, second, third]); expect(maximum).toBe(2);
  });
});
