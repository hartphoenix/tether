import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrivateStore } from "../src/storage/private-store";
import { DocumentService } from "../src/documents/document-service";
import { bodyRevision } from "../src/core/index";

test("revision storage coalesces a turn, preserves published bases and orders repeated bodies", () => {
  const store = new PrivateStore(), id = store.ensureDocument("/tmp/revision-storage.md").id;
  const revisions = store.bodyRevisions;
  revisions.record(id, "base", null, 1);
  revisions.record(id, "first", "agent", 2, "turn");
  revisions.record(id, "second", "agent", 3, "turn");
  let chain = revisions.chain(id, bodyRevision("base"));
  expect(chain.revisions).toHaveLength(1);
  expect(chain.revisions[0]).toMatchObject({ body: "second", authorId: "agent", open: true, parentRevision: bodyRevision("base") });
  revisions.publish(id, bodyRevision("second"));
  revisions.record(id, "third", "agent", 4, "turn");
  expect(revisions.chain(id, bodyRevision("second")).revisions[0]?.body).toBe("third");
  revisions.finish(id);
  expect(revisions.chain(id, bodyRevision("base")).revisions.every(r => !r.open)).toBe(true);
  revisions.record(id, "base", "human", 5);
  revisions.record(id, "after repeat", "other", 6);
  chain = revisions.chain(id, bodyRevision("base"));
  expect(chain.revisions.map(r => r.body)).toEqual(["after repeat"]);
  store.close();
});

test("retention preserves all unreviewed bodies and 50 predecessors of the reviewed body", () => {
  const store = new PrivateStore(), id = store.ensureDocument("/tmp/revision-retention.md").id;
  for (let i = 0; i < 130; i++) store.bodyRevisions.record(id, String(i), "agent", i);
  expect(store.bodyRevisions.chain(id, bodyRevision("0")).revisions).toHaveLength(129);
  expect(store.bodyRevisions.reviewed(id, bodyRevision("80"))).toBe(true);
  expect(store.bodyRevisions.chain(id, bodyRevision("29")).base).toBeNull();
  expect(store.bodyRevisions.chain(id, bodyRevision("30")).revisions).toHaveLength(99);
  store.bodyRevisions.reviewed(id, bodyRevision("50")); // A stale reader cannot move retention backwards.
  expect(store.db.query("SELECT reviewed_seq FROM body_reviews").get()).toEqual({ reviewed_seq: 81 });
  expect(store.bodyRevisions.reviewed(id, bodyRevision("missing"))).toBe(false);
  store.db.query("DELETE FROM documents WHERE id=?").run(id);
  expect(store.db.query("SELECT COUNT(*) AS n FROM body_revisions").get()).toEqual({ n: 0 });
  store.close();
});

test("service attributes sole turns, neutral overlaps, explicit saves and final writes without polling", async () => {
  const directory = await mkdtemp("/tmp/tether-body-turns-"), path = join(directory, "doc.md");
  const service = new DocumentService();
  try {
    await writeFile(path, "base");
    const grant = await service.open(path), base = await service.read(grant);
    await service.setBodyTurns(grant.documentId, [{ agentId: "alice", signalId: "a" }]);
    await writeFile(path, "alice first");
    await service.revisions(grant);
    await writeFile(path, "alice final");
    await service.setBodyTurns(grant.documentId, [{ agentId: "alice", signalId: "a" }, { agentId: "bob", signalId: "b" }]);
    await writeFile(path, "overlap");
    await service.setBodyTurns(grant.documentId, [{ agentId: "bob", signalId: "b" }]);
    await writeFile(path, "bob final");
    await service.setBodyTurns(grant.documentId, []);
    await writeFile(path, "external");
    await service.saveBody({ session: grant, body: "signed save", expectedBodyRevision: bodyRevision("external"), authorId: "alice" });
    const chain = await service.revisionChain(grant, base.bodyRevision);
    expect(chain.revisions.map(r => [r.body, r.authorId, r.open])).toEqual([
      ["alice final", "alice", false], ["overlap", null, false], ["bob final", "bob", false],
      ["external", null, false], ["signed save", "alice", false],
    ]);
    await expect(service.saveBody({ session: grant, body: "lost", expectedBodyRevision: base.bodyRevision, authorId: "bob" })).rejects.toThrow();
    expect((await service.revisionChain(grant, base.bodyRevision)).revisions).toHaveLength(5);
  } finally { service.store.close(); await rm(directory, { recursive: true, force: true }); }
});
