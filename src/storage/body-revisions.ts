import type { Database } from "bun:sqlite";
import { bodyRevision } from "../core/index";

export type BodyRevision = {
  bodyRevision: string; parentRevision: string | null; authorId: string | null;
  savedAt: number; body: string; open: boolean;
};
type Row = {
  seq: number; revision: string; parent: string | null; author: string | null;
  saved_at: number; body: string; turn: string | null; published: number;
};
const present = (row: Row): BodyRevision => ({
  bodyRevision: row.revision, parentRevision: row.parent, authorId: row.author,
  savedAt: row.saved_at, body: row.body, open: row.turn !== null,
});

/** Full bodies stay private. Content hashes identify versions, sequence numbers order repeated bodies. */
export class BodyRevisions {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS body_revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision TEXT NOT NULL, parent TEXT, author TEXT, saved_at INTEGER NOT NULL,
        body TEXT NOT NULL, turn TEXT, published INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS body_revision_document ON body_revisions(document_id, seq);
      CREATE TABLE IF NOT EXISTS body_reviews (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        reviewed_seq INTEGER NOT NULL
      );
    `);
  }
  latest(documentId: string): Row | null {
    return this.db.query("SELECT * FROM body_revisions WHERE document_id=? ORDER BY seq DESC LIMIT 1").get(documentId) as Row | null;
  }
  record(documentId: string, body: string, authorId: string | null, savedAt: number, turn: string | null = null): void {
    this.db.transaction(() => {
      const previous = this.latest(documentId), revision = bodyRevision(body);
      if (previous?.revision === revision) return;
      // Versions already delivered to a reader must remain usable as a diff base.
      if (turn && previous?.turn === turn && previous.author === authorId && !previous.published) {
        this.db.query("UPDATE body_revisions SET revision=?,body=?,saved_at=? WHERE seq=?").run(revision, body, savedAt, previous.seq);
      } else {
        this.finish(documentId);
        this.db.query("INSERT INTO body_revisions(document_id,revision,parent,author,saved_at,body,turn) VALUES(?,?,?,?,?,?,?)")
          .run(documentId, revision, previous?.revision ?? null, previous ? authorId : null, savedAt, body, previous ? turn : null);
      }
    })();
  }
  finish(documentId: string): void {
    this.db.query("UPDATE body_revisions SET turn=NULL WHERE document_id=? AND turn IS NOT NULL").run(documentId);
  }
  /** A daemon restart cannot attribute unobserved writes to an old turn. */
  finishAll(): void { this.db.exec("UPDATE body_revisions SET turn=NULL WHERE turn IS NOT NULL"); }
  publish(documentId: string, revision: string): void {
    this.db.query("UPDATE body_revisions SET published=1 WHERE seq=(SELECT MAX(seq) FROM body_revisions WHERE document_id=? AND revision=?)").run(documentId, revision);
  }
  chain(documentId: string, from: string): { base: { bodyRevision: string; body: string } | null; revisions: BodyRevision[] } {
    const base = this.db.query("SELECT * FROM body_revisions WHERE document_id=? AND revision=? ORDER BY seq DESC LIMIT 1").get(documentId, from) as Row | null;
    if (!base) return { base: null, revisions: [] };
    const rows = this.db.query("SELECT * FROM body_revisions WHERE document_id=? AND seq>? ORDER BY seq").all(documentId, base.seq) as Row[];
    return { base: { bodyRevision: base.revision, body: base.body }, revisions: rows.map(present) };
  }
  reviewed(documentId: string, revision: string): boolean {
    const row = this.db.query("SELECT seq FROM body_revisions WHERE document_id=? AND revision=? ORDER BY seq DESC LIMIT 1").get(documentId, revision) as { seq: number } | null;
    if (!row) return false;
    this.db.transaction(() => {
      this.publish(documentId, revision);
      this.db.query(`INSERT INTO body_reviews VALUES(?,?) ON CONFLICT(document_id)
        DO UPDATE SET reviewed_seq=MAX(reviewed_seq,excluded.reviewed_seq)`).run(documentId, row.seq);
      // Keep the reviewed version, its 50 predecessors, and every later revision.
      const cutoff = this.db.query(`SELECT seq FROM body_revisions WHERE document_id=? AND
        seq<=(SELECT reviewed_seq FROM body_reviews WHERE document_id=?) ORDER BY seq DESC LIMIT 1 OFFSET 50`).get(documentId, documentId) as { seq: number } | null;
      if (cutoff) this.db.query("DELETE FROM body_revisions WHERE document_id=? AND seq<?").run(documentId, cutoff.seq);
    })();
    return true;
  }
}
