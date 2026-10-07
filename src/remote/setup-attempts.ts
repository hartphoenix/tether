import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export type SetupAnswers = { hub: string; machine: string; access: "paseo" | "browser"; qualifyPaths: boolean; internet: boolean; relocate?: boolean; machineId?: string };
type Contact = { name: string; hash: string; code: string; approved: boolean; expiresAt: number };
export type SetupAttempt = { id: string; answers: SetupAnswers; createdAt: number; expiresAt: number; phase: string; report?: string; verification?: Record<string, unknown>; contact?: Omit<Contact, "hash"> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string, status = 400) => Object.assign(new Error(message), { code: "setup_invalid", status });

/** Agent reports are explicitly unverified; this capability cannot access the library. */
export class SetupAttempts {
  constructor(private readonly db: Database, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS setup_attempts (
      id TEXT PRIMARY KEY, answers TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, phase TEXT NOT NULL, report TEXT, contact TEXT
    )`);
    if (!(db.query("PRAGMA table_info(setup_attempts)").all() as {name:string}[]).some(column => column.name === "verification")) db.exec("ALTER TABLE setup_attempts ADD COLUMN verification TEXT");
  }
  private row(id: string): any {
    const row = this.db.query("SELECT * FROM setup_attempts WHERE id=?").get(id);
    if (!row) throw fail("Setup attempt not found.", 404);
    return row;
  }
  get(id: string): SetupAttempt {
    const row = this.row(id), contact = row.contact ? JSON.parse(row.contact) as Contact : undefined;
    return { id, answers: JSON.parse(row.answers), createdAt: row.created_at, expiresAt: row.expires_at, phase: row.phase,
      ...(row.verification ? { verification: JSON.parse(row.verification) } : {}),
      ...(row.report ? { report: row.report } : {}), ...(contact ? { contact: { name: contact.name, code: contact.code, approved: contact.approved, expiresAt: contact.expiresAt } } : {}) };
  }
  list(): SetupAttempt[] { return (this.db.query("SELECT id FROM setup_attempts ORDER BY created_at DESC LIMIT 20").all() as {id:string}[]).map(row => this.get(row.id)); }
  save(input: unknown, id?: string): SetupAttempt {
    const value = input as SetupAnswers;
    if (!value || !["paseo", "browser"].includes(value.access) || typeof value.internet !== "boolean" || typeof value.qualifyPaths !== "boolean"
      || [value.hub, value.machine].some(name => typeof name !== "string" || name.length > 100 || /[\p{Cc}]/u.test(name))) throw fail("Complete the setup questions.");
    if (value.machineId !== undefined && (typeof value.machineId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.machineId))) throw fail("Select a retained file machine.");
    const answers: SetupAnswers = { hub: value.hub.trim(), machine: value.machine.trim(), access: value.access, qualifyPaths: value.qualifyPaths, internet: value.internet, ...(value.relocate === true ? { relocate: true } : {}), ...(value.machineId ? { machineId: value.machineId } : {}) };
    if (!answers.hub || answers.access === "paseo" && !answers.machine) throw fail("Name the hub and selected file machine.");
    const createdAt = this.now();
    if (id) {
      this.row(id);
      this.db.query("UPDATE setup_attempts SET answers=?,expires_at=?,phase='draft',report=NULL,contact=NULL,verification=NULL WHERE id=?").run(JSON.stringify(answers), createdAt + 86_400_000, id);
    } else {
      id = randomUUID();
      this.db.query("INSERT INTO setup_attempts(id,answers,created_at,expires_at,phase) VALUES(?,?,?,?, 'draft')").run(id, JSON.stringify(answers), createdAt, createdAt + 86_400_000);
    }
    return this.get(id);
  }
  approve(id: string, code: string): SetupAttempt {
    const row = this.row(id), contact = row.contact && JSON.parse(row.contact) as Contact;
    if (!contact || contact.expiresAt <= this.now() || contact.code !== code || row.expires_at <= this.now()) throw fail("This contact request expired. Ask the agent to reconnect.", 409);
    contact.approved = true;
    this.db.query("UPDATE setup_attempts SET contact=?,phase='awaiting prerequisites' WHERE id=?").run(JSON.stringify(contact), id);
    return this.get(id);
  }
  cancelAll(): void { this.db.exec("UPDATE setup_attempts SET contact=NULL,phase='cancelled'"); }
  verified(id: string, observations: Record<string, unknown>): SetupAttempt {
    const attempt = this.get(id);
    if (attempt.expiresAt <= this.now() || attempt.phase === "cancelled") throw fail("Resume this setup before verifying it.", 410);
    const answers = { ...attempt.answers, ...(attempt.answers.access === "paseo" ? { machineId: observations.machineId } : {}) };
    this.db.query("UPDATE setup_attempts SET phase='verified',contact=NULL,answers=?,verification=? WHERE id=?").run(JSON.stringify(answers), JSON.stringify({ ...observations, verifiedAt: this.now() }), id);
    return this.get(id);
  }
  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/setup/") || request.method !== "POST") return null;
    const { sharedJson } = await import("./shared-auth");
    const body = await sharedJson(request, 8192);
    if (typeof body.attemptId !== "string") throw fail("A setup attempt is required.");
    const row = this.row(body.attemptId);
    if (row.expires_at <= this.now() || ["cancelled", "verified"].includes(row.phase)) throw fail("Restart this setup from Settings.", 410);
    const previous: Contact | null = row.contact ? JSON.parse(row.contact) : null;
    if (path === "/setup/contact") {
      if (previous && previous.expiresAt > this.now() && typeof body.capability === "string" && digest(body.capability) === previous.hash) return Response.json({ code: previous.code, approved: previous.approved, expiresAt: previous.expiresAt });
      if (previous && previous.expiresAt > this.now()) throw fail("A contact request is already pending; resume with its private capability.", 409);
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) throw fail("Name the requesting agent.");
      if (typeof body.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.capability)) throw fail("Persist a private reporting capability before requesting contact.");
      const capability = body.capability, code = randomBytes(4).toString("hex").toUpperCase();
      const contact: Contact = { name: body.name.trim(), hash: digest(capability), code, approved: false, expiresAt: this.now() + 30 * 60_000 };
      this.db.query("UPDATE setup_attempts SET contact=?,phase='awaiting reporting approval' WHERE id=?").run(JSON.stringify(contact), row.id);
      return Response.json({ code, expiresAt: contact.expiresAt });
    }
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!previous || !token || digest(token) !== previous.hash || previous.expiresAt <= this.now()) throw fail("Setup reporting authorization expired.", 403);
    if (path === "/setup/status") return Response.json({ approved: previous.approved, phase: row.phase, expiresAt: previous.expiresAt });
    if (path !== "/setup/report" || !previous.approved) throw fail("Approve this agent's reporting request in Settings.", 403);
    if (typeof body.report !== "string" || body.report.length > 2000 || !["awaiting prerequisites", "awaiting owner", "awaiting approval", "installed", "needs repair"].includes(body.phase)) throw fail("Report a supported setup phase and a brief observation.");
    this.db.query("UPDATE setup_attempts SET report=?,phase=? WHERE id=?").run(body.report, body.phase, row.id);
    return Response.json({ reported: true, verified: false });
  }
}
