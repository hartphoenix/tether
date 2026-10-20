import type { Database } from "bun:sqlite";

export type SavedTurn = {
  path: string;
  agentId: string;
  label?: string;
  state: "ready" | "queued" | "working" | "unavailable";
  reason?: string;
  signalId?: string;
  acceptedAt?: string;
};

/** Registrations and receipts survive; pending work is never replayed on startup. */
export class TurnStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_registrations (
      path TEXT NOT NULL, agent_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(path,agent_id));
      CREATE TABLE IF NOT EXISTS turn_signals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  restore(): SavedTurn[] {
    return (this.db.query("SELECT payload FROM turn_registrations").all() as { payload: string }[]).map(row => {
      const turn = JSON.parse(row.payload) as SavedTurn;
      if (turn.state === "queued" || turn.state === "working") {
        turn.reason = turn.acceptedAt
          ? "Tether restarted after host acceptance; turn completion is unknown. No replay attempted."
          : "Tether restarted before delivery was confirmed; held press dropped, delivery may be uncertain. No replay attempted.";
        turn.state = "unavailable";
        this.save(turn);
      }
      return turn;
    });
  }
  save(turn: SavedTurn): void {
    this.db.query("INSERT INTO turn_registrations VALUES (?,?,?) ON CONFLICT(path,agent_id) DO UPDATE SET payload=excluded.payload")
      .run(turn.path, turn.agentId, JSON.stringify(turn));
  }
  remove(path: string, agentId: string): void {
    this.db.query("DELETE FROM turn_registrations WHERE path=? AND agent_id=?").run(path, agentId);
  }
  receipt(signalId: string): Record<string, unknown> | undefined {
    const row = this.db.query("SELECT payload FROM turn_signals WHERE id=?").get(signalId) as { payload: string } | null;
    return row ? JSON.parse(row.payload) : undefined;
  }
  record(signal: { signalId: string } & Record<string, unknown>): void {
    this.db.query("INSERT INTO turn_signals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(signal.signalId, JSON.stringify(signal));
  }
}
