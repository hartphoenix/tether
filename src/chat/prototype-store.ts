import type { Database } from "bun:sqlite";

export type Draft = { id: string; quote: string; feedback: string };
export type Submission = { id: string; prose: string; text: string; attachments: unknown[]; draftIds: string[]; messageId: string | null; wire: string | null; state: "prepared" | "dispatching" };
export type ChatState = { drafts: Draft[]; submission: Submission | null };

/** Isolated prototype tables, owned by a Tether service process. No document ledger writes. */
export class PrototypeStore {
  constructor(private db: Database) {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_probe_drafts(scope TEXT NOT NULL, id TEXT NOT NULL, quote TEXT NOT NULL, feedback TEXT NOT NULL, ordinal INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE(scope,id));
      CREATE TABLE IF NOT EXISTS chat_probe_submissions(scope TEXT PRIMARY KEY, id TEXT NOT NULL, payload TEXT NOT NULL);
    `);
  }
  read(scope: string): ChatState {
    const drafts = this.db.query("SELECT id,quote,feedback FROM chat_probe_drafts WHERE scope=? ORDER BY ordinal").all(scope) as Draft[];
    const row = this.db.query("SELECT payload FROM chat_probe_submissions WHERE scope=?").get(scope) as { payload: string } | null;
    return { drafts, submission: row ? JSON.parse(row.payload) : null };
  }
  save(scope: string, draft: Draft) {
    return this.db.transaction(() => {
      const captured = this.read(scope).submission?.draftIds.includes(draft.id);
      if (captured) throw new Error("This item belongs to an immutable pending submission.");
      this.db.query("INSERT INTO chat_probe_drafts(scope,id,quote,feedback) VALUES (?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET quote=excluded.quote,feedback=excluded.feedback").run(scope, draft.id, draft.quote, draft.feedback);
      return this.read(scope);
    })();
  }
  capture(scope: string, id: string, prose: string, attachments: unknown[]): ChatState {
    return this.db.transaction(() => {
      const current = this.read(scope);
      if (current.submission) {
        if (current.submission.id === id && current.submission.prose === prose && JSON.stringify(current.submission.attachments) === JSON.stringify(attachments)) return current;
        throw new Error("One pending submission per test chat. Reconcile it before sending another.");
      }
      if (!current.drafts.length) throw new Error("Save a test quote first.");
      const blocks = current.drafts.map(d => `<chat-selection>\n  text: ${JSON.stringify(d.quote)}\n  feedback: ${JSON.stringify(d.feedback)}\n</chat-selection>`).join("\n\n");
      const submission: Submission = { id, prose, text: [prose.trim(), blocks].filter(Boolean).join("\n\n"), attachments, draftIds: current.drafts.map(d => d.id), messageId: null, wire: null, state: "prepared" };
      this.db.query("INSERT INTO chat_probe_submissions(scope,id,payload) VALUES (?,?,?)").run(scope, id, JSON.stringify(submission));
      return this.read(scope);
    })();
  }
  dispatch(scope: string, id: string, messageId: string, text: string, options: unknown) {
    return this.db.transaction(() => {
      const submission = this.require(scope, id);
      if (submission.state !== "prepared") throw new Error("Delivery is uncertain; reconcile the saved message ID. No automatic retry.");
      if (text !== submission.text) throw new Error("Native payload changed; delivery blocked.");
      submission.state = "dispatching";
      submission.messageId = messageId;
      submission.wire = JSON.stringify({ text, options });
      this.db.query("UPDATE chat_probe_submissions SET payload=? WHERE scope=?").run(JSON.stringify(submission), scope);
      return this.read(scope);
    })();
  }
  accepted(scope: string, id: string, messageId: string) {
    return this.db.transaction(() => {
      const current = this.read(scope);
      if (!current.submission) return current; // Retrying cleanup after its reply was lost.
      const submission = this.require(scope, id);
      if (submission.messageId !== messageId || submission.state !== "dispatching") throw new Error("Acceptance identity mismatch.");
      for (const draftId of submission.draftIds) this.db.query("DELETE FROM chat_probe_drafts WHERE scope=? AND id=?").run(scope, draftId);
      this.db.query("DELETE FROM chat_probe_submissions WHERE scope=? AND id=?").run(scope, id);
      return this.read(scope);
    })();
  }
  cancelPrepared(scope: string, id: string) {
    const submission = this.require(scope, id);
    if (submission.state !== "prepared") throw new Error("May already be accepted. Reconcile before changing this batch.");
    this.db.query("DELETE FROM chat_probe_submissions WHERE scope=? AND id=?").run(scope, id);
    return this.read(scope);
  }
  private require(scope: string, id: string): Submission {
    const submission = this.read(scope).submission;
    if (!submission || submission.id !== id) throw new Error("Submission identity mismatch.");
    return submission;
  }
}
