import type { Database } from "bun:sqlite";
import { ChatStateError, formatDrafts, parseChatRequest, type ChatState, type Submission } from "../../integrations/paseo/chat/model";

/** Only the Tether daemon opens these tables, alongside its private document store. */
export class ChatStore {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_drafts(scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,ordinal INTEGER PRIMARY KEY AUTOINCREMENT,UNIQUE(scope,id));
      CREATE TABLE IF NOT EXISTS chat_submissions(scope TEXT PRIMARY KEY,id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_deleted(scope TEXT PRIMARY KEY);`);
  }
  read(scope: string): ChatState {
    const rows = this.db.query("SELECT payload FROM chat_drafts WHERE scope=? ORDER BY ordinal").all(scope) as { payload: string }[];
    const row = this.db.query("SELECT payload FROM chat_submissions WHERE scope=?").get(scope) as { payload: string } | null;
    return { drafts: rows.map(r => JSON.parse(r.payload)), submission: row ? JSON.parse(row.payload) : null };
  }
  operate(value: unknown): ChatState {
    const { host, agent, operation: op } = parseChatRequest(value);
    const scope = JSON.stringify([host, agent]);
    return this.db.transaction(() => {
      if (op.kind !== "read" && op.kind !== "deleteChat" && this.db.query("SELECT scope FROM chat_deleted WHERE scope=?").get(scope)) throw new ChatStateError("This chat was permanently deleted.");
      const current = this.read(scope), pending = current.submission;
      const requirePending = (id: string): Submission => {
        if (!pending || pending.id !== id) throw new ChatStateError("Submission identity mismatch.");
        return pending;
      };
      switch (op.kind) {
        case "read": return current;
        case "save": case "remove": {
          const id = op.kind === "save" ? op.draft.id : op.id;
          if (pending?.draftIds.includes(id)) throw new ChatStateError("This annotation is awaiting delivery. Recover the batch before editing.");
          if (op.kind === "save") this.db.query("INSERT INTO chat_drafts(scope,id,payload) VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET payload=excluded.payload").run(scope, id, JSON.stringify(op.draft));
          else this.db.query("DELETE FROM chat_drafts WHERE scope=? AND id=?").run(scope, id);
          break;
        }
        case "capture": {
          if (pending) {
            if (pending.id === op.id && pending.prose === op.prose && JSON.stringify(pending.attachments) === JSON.stringify(op.attachments)) return current;
            throw new ChatStateError("An annotation batch is already awaiting delivery.");
          }
          if (!current.drafts.length) return current;
          const submission: Submission = { id: op.id, prose: op.prose, text: [op.prose.trim(), formatDrafts(current.drafts)].filter(Boolean).join("\n\n"), attachments: op.attachments, draftIds: current.drafts.map(d => d.id), messageId: null, wire: null, state: "prepared" };
          this.db.query("INSERT INTO chat_submissions(scope,id,payload) VALUES (?,?,?)").run(scope, op.id, JSON.stringify(submission));
          break;
        }
        case "dispatch": {
          const p = requirePending(op.id);
          if (p.state !== "prepared") throw new ChatStateError("Delivery uncertain. Check acceptance before retrying.");
          if (p.text !== op.text) throw new ChatStateError("Queued annotation text changed; saved work retained.");
          p.state = "dispatching"; p.messageId = op.messageId; p.wire = JSON.stringify({ text: op.text, options: op.options });
          this.db.query("UPDATE chat_submissions SET payload=? WHERE scope=? AND id=?").run(JSON.stringify(p), scope, p.id);
          break;
        }
        case "accepted": {
          if (!pending) return current;
          const p = requirePending(op.id);
          if (p.state !== "dispatching" || p.messageId !== op.messageId) throw new ChatStateError("Acceptance identity mismatch.");
          for (const id of p.draftIds) this.db.query("DELETE FROM chat_drafts WHERE scope=? AND id=?").run(scope, id);
          this.db.query("DELETE FROM chat_submissions WHERE scope=? AND id=?").run(scope, p.id);
          break;
        }
        case "cancelPrepared": {
          const p = requirePending(op.id);
          if (p.state !== "prepared") throw new ChatStateError("Delivery uncertain; saved work retained.");
          this.db.query("DELETE FROM chat_submissions WHERE scope=? AND id=?").run(scope, p.id);
          break;
        }
        case "deleteChat":
          this.db.query("INSERT OR IGNORE INTO chat_deleted(scope) VALUES (?)").run(scope);
          this.db.query("DELETE FROM chat_drafts WHERE scope=?").run(scope);
          this.db.query("DELETE FROM chat_submissions WHERE scope=?").run(scope);
      }
      return this.read(scope);
    })();
  }
}
