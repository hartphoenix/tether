import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision, splitAnnotationLedger } from "../src/core/index";
import {
  DocumentAccessError,
  DocumentConflictError,
  DocumentReadOnlyError,
  DocumentService,
  RealPathMutationQueue,
} from "../src/documents/index";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(source = "Hello world\n") {
  const directory = await mkdtemp(join("/tmp", "tether-documents-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, source);
  return { directory, path };
}

describe("DocumentService grants", () => {
  test("opens an explicit canonical file without Recents and denies another path", async () => {
    const file = await fixture();
    const other = join(file.directory, "other.md");
    await writeFile(other, "Other\n");
    const service = new DocumentService();
    const session = await service.open(file.path);
    expect(session.path).toBe(await realpath(file.path));
    expect((await service.read(session)).body).toBe("Hello world\n");
    await expect(service.read(other)).rejects.toBeInstanceOf(DocumentAccessError);
    await expect(service.read({ ...session, sessionId: crypto.randomUUID(), id: "bad" })).rejects.toBeInstanceOf(DocumentAccessError);
  });

  test("returns exact source bytes and preserves source permissions through saves", async () => {
    const file = await fixture("Body\n");
    await chmod(file.path, 0o640);
    const service = new DocumentService();
    const session = await service.open(file.path);
    const initial = await service.read(session);
    expect(await service.exportExact(session)).toBe("Body\n");
    const saved = await service.saveBody({ session, body: "Changed\n", expectedBodyRevision: initial.bodyRevision });
    expect(saved.body).toBe("Changed\n");
    expect((await stat(file.path)).mode & 0o777).toBe(0o640);
  });
});

describe("DocumentService review transactions", () => {
  test("derives pending, thread, and exact-export payloads from one source read each", async () => {
    const file = await fixture("Single snapshot\n");
    let reads = 0;
    const service = new DocumentService({
      readText: async (path) => {
        reads += 1;
        return await readFile(path, "utf8");
      },
    });
    const session = await service.open(file.path);
    const initial = await service.read(session);
    const commented = await service.appendComment({
      session,
      actor: "hart",
      expectedBodyRevision: initial.bodyRevision,
      body: "One read only.",
      anchor: { exact: "Single", prefix: "", suffix: " snapshot", projectionStart: 0, projectionEnd: 6, bodyRevision: initial.bodyRevision },
    });
    const threadId = (commented.annotations.events[0] as { id: string }).id;

    reads = 0;
    const pending = await service.pending(session, "assistant");
    expect(reads).toBe(1);
    expect(pending.bodyRevision).toBe(commented.bodyRevision);
    expect(pending.annotations.events).toHaveLength(1);

    reads = 0;
    expect((await service.thread(session, threadId)).thread.id).toBe(threadId);
    expect(reads).toBe(1);

    reads = 0;
    const exact = await service.readExactSnapshot(session);
    expect(reads).toBe(1);
    expect(exact.document.ledgerRevision).toBe(commented.ledgerRevision);
    expect(exact.source).toBe(await readFile(file.path, "utf8"));
  });

  test("preserves exact transitional ledger bytes through body saves", async () => {
    const file = await fixture("Body before save\n");
    const service = new DocumentService();
    const session = await service.open(file.path);
    const initial = await service.read(session);
    const commented = await service.appendComment({
      session,
      actor: "hart",
      expectedBodyRevision: initial.bodyRevision,
      body: "Keep this byte envelope.",
      anchor: { exact: "Body", prefix: "", suffix: " before", projectionStart: 0, projectionEnd: 4, bodyRevision: initial.bodyRevision },
    });
    const before = splitAnnotationLedger(await service.exportExact(session));
    const saved = await service.saveBody({ session, body: "Body after save\n", expectedBodyRevision: commented.bodyRevision });
    const after = splitAnnotationLedger(await service.exportExact(session));
    expect(after.ledgerText).toBe(before.ledgerText);
    expect(saved.ledgerRevision).toBe(commented.ledgerRevision);
    expect(after.body).toBe("Body after save\n");
  });

  test("keeps body and ledger revisions independent and supports every review action", async () => {
    const file = await fixture("Hello world\n");
    const service = new DocumentService({ now: () => 1_700_000_000_000 });
    const session = await service.open(file.path);
    const initial = await service.read(session);
    const comment = await service.appendEvent({
      session,
      type: "comment",
      actor: "hart",
      expectedBodyRevision: initial.bodyRevision,
      body: "Please clarify.",
      anchor: { exact: "Hello", prefix: "", suffix: " world", projectionStart: 0, projectionEnd: 5, bodyRevision: initial.bodyRevision },
    });
    const threadId = (comment.annotations.events[0] as { id: string }).id;
    expect(comment.bodyRevision).toBe(initial.bodyRevision);
    expect(comment.ledgerRevision).not.toBe(initial.ledgerRevision);
    const reply = await service.reply({ session, actor: "assistant", threadId, body: "Here is the clarification." });
    const edited = await service.edit({ session, actor: "assistant", threadId, targetId: (reply.annotations.events[1] as { id: string }).id, body: "Updated clarification." });
    expect((edited.annotations.threads[0] as { replies: Array<{ body: string }> }).replies[0].body).toBe("Updated clarification.");
    const resolved = await service.resolve({ session, actor: "hart", threadId });
    expect((resolved.annotations.threads[0] as { status: string }).status).toBe("resolved");
    const reopened = await service.reopen({ session, actor: "hart", threadId });
    expect((reopened.annotations.threads[0] as { status: string }).status).toBe("open");
    const deleted = await service.delete({ session, actor: "assistant", threadId, targetId: (reply.annotations.events[1] as { id: string }).id });
    expect((deleted.annotations.threads[0] as { replies: unknown[] }).replies).toHaveLength(0);
    const acknowledged = await service.acknowledge({ session, actor: "assistant", throughSeq: 5, bodyRevision: initial.bodyRevision });
    expect(acknowledged.annotations.acknowledgements).toHaveLength(1);
    expect((await service.pending(session, "assistant")).events).toHaveLength(0);
    const source = await service.exportExact(session);
    expect(splitAnnotationLedger(source).ledger?.events).toHaveLength(7);
  });

  test("serializes concurrent same-file appends", async () => {
    const file = await fixture("Concurrent target\n");
    const service = new DocumentService();
    const session = await service.open(file.path);
    const initial = await service.read(session);
    const append = (body: string) => service.appendComment({
      session,
      actor: "hart",
      expectedBodyRevision: initial.bodyRevision,
      body,
      anchor: { exact: "Concurrent", prefix: "", suffix: " target", projectionStart: 0, projectionEnd: 10, bodyRevision: initial.bodyRevision },
    });
    const results = await Promise.all([append("First"), append("Second")]);
    expect(results.map((result) => result.annotations.events.at(-1) && (result.annotations.events.at(-1) as { seq: number }).seq)).toEqual([1, 2]);
    expect((await service.read(session)).annotations.events).toHaveLength(2);
  });

  test("returns malformed ledgers read-only and never overwrites them", async () => {
    const source = "Body\n<!-- wave-annotations:v1\nnot-json\n-->\n";
    const file = await fixture(source);
    const service = new DocumentService();
    const session = await service.open(file.path);
    const snapshot = await service.read(session);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.body).toBe("Body\n");
    expect(snapshot.ledgerError).toContain("Malformed annotation JSON");
    await expect(service.saveBody({ session, body: "Changed\n", expectedBodyRevision: bodyRevision("Body\n") })).rejects.toBeInstanceOf(DocumentReadOnlyError);
    expect(await readFile(file.path, "utf8")).toBe(source);
  });

  test("checks expected body and ledger revisions", async () => {
    const file = await fixture();
    const service = new DocumentService();
    const session = await service.open(file.path);
    const initial = await service.read(session);
    await expect(service.saveBody({ session, body: "Changed\n", expectedBodyRevision: bodyRevision("stale\n") })).rejects.toBeInstanceOf(DocumentConflictError);
    await expect(service.appendComment({ session, actor: "hart", expectedBodyRevision: initial.bodyRevision, expectedLedgerRevision: "sha256:bad", body: "Nope", anchor: { exact: "Hello", prefix: "", suffix: " world", projectionStart: 0, projectionEnd: 5, bodyRevision: initial.bodyRevision } })).rejects.toBeInstanceOf(DocumentConflictError);
  });
});

describe("RealPathMutationQueue", () => {
  test("serializes one path and allows another path concurrently", async () => {
    const queue = new RealPathMutationQueue();
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("/tmp/one.md", async () => { active += 1; maximum = Math.max(maximum, active); await gate; active -= 1; });
    const second = queue.run("/tmp/one.md", async () => { active += 1; maximum = Math.max(maximum, active); active -= 1; });
    const third = queue.run("/tmp/two.md", async () => { active += 1; maximum = Math.max(maximum, active); active -= 1; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(1);
    release();
    await Promise.all([first, second, third]);
    expect(maximum).toBe(2);
  });
});
