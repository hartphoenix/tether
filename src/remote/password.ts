import type { Database } from "bun:sqlite";

/** One owner, so guessing limits are account-wide and survive restarts. */
export class OwnerPassword {
  private busy = false;
  constructor(private readonly db: Database, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS owner_password (
      id INTEGER PRIMARY KEY CHECK(id=1), verifier TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
    )`);
  }
  configured(): boolean { return !!this.db.query("SELECT id FROM owner_password WHERE id=1").get(); }
  async set(password: unknown, authorize: () => boolean = () => true): Promise<void> {
    if (typeof password !== "string" || [...password].length < 15 || [...password].length > 128 || new Set(password).size < 5) {
      throw Object.assign(new Error("Use a unique password or passphrase of 15–128 characters."), { code: "weak_password", status: 400 });
    }
    const verifier = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    if (!authorize()) throw Object.assign(new Error("Owner authorization changed. Retry from Settings."), { code: "access_denied", status: 403 });
    this.db.query("INSERT INTO owner_password(id,verifier) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET verifier=excluded.verifier,failures=0,retry_at=0").run(verifier);
  }
  async verify(password: unknown): Promise<boolean> {
    const row = this.db.query("SELECT verifier,failures,retry_at FROM owner_password WHERE id=1").get() as { verifier: string; failures: number; retry_at: number } | null;
    if (this.busy || row && row.retry_at > this.now()) throw Object.assign(new Error("Please wait before trying your password again."), { code: "rate_limited", status: 429 });
    if (!row || typeof password !== "string" || password.length > 512) return false;
    this.busy = true;
    // Reserve the next attempt before expensive verification; crashes do not reset it.
    this.db.query("UPDATE owner_password SET failures=failures+1,retry_at=? WHERE id=1").run(this.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.failures, 9)));
    try {
      const valid = await Bun.password.verify(password, row.verifier);
      if (valid) this.db.query("UPDATE owner_password SET failures=0,retry_at=0 WHERE id=1 AND verifier=?").run(row.verifier);
      return valid && (this.db.query("SELECT verifier FROM owner_password WHERE id=1").get() as {verifier:string})?.verifier === row.verifier;
    } finally { this.busy = false; }
  }
}
