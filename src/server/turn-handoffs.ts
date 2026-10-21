import type { Database } from "bun:sqlite";

export type TurnHandoff = {
  id: string; documentId: string; kind: "assign" | "takeover"; expiresAt: number;
  additional?: boolean;
  roleId?: string; expectedRecipient?: string;
  receipt?: { recipientId: string; hostId: string; owner: string; roleId: string };
};
export const handoffFailure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 409, details: { outcome: "not_applied" } });

/** References are selectors, never authorization. All use goes through authenticated control. */
export class TurnHandoffs {
  constructor(private db: Database, private now = Date.now) {
    db.exec("CREATE TABLE IF NOT EXISTS turn_handoffs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)");
  }
  create(input: Pick<TurnHandoff, "documentId" | "kind" | "additional" | "roleId" | "expectedRecipient">): TurnHandoff {
    this.db.query("DELETE FROM turn_handoffs WHERE expires_at <= ?").run(this.now());
    const value = { ...input, id: `handoff:${crypto.randomUUID()}`, expiresAt: this.now() + 7 * 24 * 60 * 60 * 1000 };
    this.db.query("INSERT INTO turn_handoffs VALUES(?,?,?)").run(value.id, value.expiresAt, JSON.stringify(value));
    return value;
  }
  read(id: unknown): TurnHandoff {
    if (typeof id !== "string" || !/^handoff:[a-f0-9-]{36}$/.test(id)) throw handoffFailure("invalid_handoff", "Use the handoff reference from a copied Go prompt.");
    const row = this.db.query("SELECT payload FROM turn_handoffs WHERE id=?").get(id) as { payload: string } | null;
    const value: TurnHandoff | undefined = row ? JSON.parse(row.payload) : undefined;
    if (!value || value.expiresAt <= this.now()) throw handoffFailure("handoff_expired", "This handoff is missing or expired. Copy a fresh prompt from the intended Tether profile.");
    return value;
  }
  complete(value: TurnHandoff, receipt: NonNullable<TurnHandoff["receipt"]>): void {
    this.db.query("UPDATE turn_handoffs SET payload=? WHERE id=?").run(JSON.stringify({ ...value, receipt }), value.id);
  }
}
