import { DurableMap } from "../storage/durable-map";
import { Machines } from "../storage/machines";
import { OwnerPassword } from "./password";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { PasskeyProvider } from "./passkeys";

export type SharedClientKind = "browser" | "agent" | "connector";
export type SharedClient = {
  id: string; name: string; kind: SharedClientKind; machineId: string | null;
  createdAt: number; expiresAt: number; revokedAt: number | null;
};
export type SharedCredential = {
  origin: string; clientId: string; machineId: string | null; token: string; expiresAt: number;
};
export class SharedAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403, readonly details?: unknown) { super(message); }
}
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const SESSION = "__Host-tether-shared", BINDING = "__Host-tether-owner";
const FIVE_MINUTES = 300_000, CHALLENGE_MS = 120_000, DAY = 86_400_000;
const selectClients = "SELECT id,name,kind,machine_id AS machineId,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM shared_clients";
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
function getCookie(request: Request, name: string): string {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : "";
}
function deny(message = "Owner verification is required or has expired."): never { throw new SharedAccessError("access_denied", message); }
function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /\p{Cc}/u.test(value)) throw new SharedAccessError("invalid_client", "Client name must be 1–100 printable characters.", 400);
  return value.trim();
}
export function sharedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SharedAccessError("invalid_origin", "An exact HTTPS origin is required.", 400); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new SharedAccessError("invalid_origin", "An exact HTTPS origin is required.", 400);
  return url.origin;
}
export async function sharedJson(request: Pick<Request, "headers" | "body">, limit = 128 * 1024): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new SharedAccessError("invalid_request", "JSON is required.", 400);
  const reader = request.body?.getReader(); if (!reader) throw new SharedAccessError("invalid_request", "A request body is required.", 400);
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel(); throw new SharedAccessError("request_too_large", "Request body is too large.", 413); }
    chunks.push(value);
  }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new SharedAccessError("invalid_request", "Invalid JSON.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SharedAccessError("invalid_request", "A JSON object is required.", 400);
  return value as Record<string, any>;
}
type Pairing = { name: string; kind: "agent" | "connector"; machineId: string | null; codeHash: string; clientId?: string; qualifyPaths?: boolean; machineName?: string; pollHash: string; expires: number; attempts: number; approved: boolean };
type Challenge = { challenge: string; action: "login" | "approve" | "list" | "revoke" | "register" | "replace"; binding: string; expires: number; epoch: number; name?: string; target?: string };

/** One owner authority and equal library access for individually revocable clients. */
export class SharedAuth {
  readonly origin: string;
  private readonly now: () => number;
  private readonly pairings: DurableMap<Pairing>;
  readonly machines: Machines;
  readonly password: OwnerPassword;
  private readonly challenges = new Map<string, Challenge>();
  private readonly listeners = new Set<(clientId: string) => void>();
  private enrollment?: { hash: string; expires: number; replace: boolean; attempts: number };
  private epoch = 0;
  private rate = { window: 0, count: 0 };
  constructor(private readonly options: { db: Database; passkeys: PasskeyProvider; origin: string; localMachineId?: string; now?: () => number }) {
    this.origin = sharedOrigin(options.origin); this.now = options.now ?? Date.now;
    this.pairings = new DurableMap(options.db, "pairings");
    this.machines = new Machines(options.db);
    this.password = new OwnerPassword(options.db, this.now);
    options.db.exec("CREATE TABLE IF NOT EXISTS shared_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    options.db.exec(`CREATE TABLE IF NOT EXISTS shared_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('browser','agent','connector')),
      machine_id TEXT, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    ); CREATE INDEX IF NOT EXISTS shared_clients_token ON shared_clients(token_hash);
    DROP INDEX IF EXISTS shared_clients_machine;
    CREATE UNIQUE INDEX IF NOT EXISTS shared_connector_machine ON shared_clients(machine_id) WHERE revoked_at IS NULL AND machine_id IS NOT NULL AND kind='connector';`);
  }
  enabled(): boolean { return (this.options.db.query("SELECT value FROM shared_state WHERE key='enabled'").get() as {value:string} | null)?.value !== "false"; }
  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.epoch++; this.challenges.clear(); this.pairings.clear(); this.enrollment = undefined;
      for (const client of this.clients()) this.revoke(client.id);
    }
    this.options.db.query("INSERT OR REPLACE INTO shared_state(key,value) VALUES('enabled',?)").run(String(enabled));
  }
  revokeMachine(machineId: string): string[] {
    const ids = this.clients().filter(client => client.machineId === machineId && client.revokedAt === null).map(client => client.id);
    for (const [id, pair] of this.pairings) if (pair.machineId === machineId) this.pairings.delete(id);
    for (const id of ids) this.revoke(id);
    return ids;
  }
  associate(clientId: string, machineId: string): void {
    const client = this.client(clientId);
    if (!client || client.kind !== "agent" || !this.machines.get(machineId)) deny("Select an agent client and an existing file machine.");
    this.options.db.query("UPDATE shared_clients SET machine_id=? WHERE id=?").run(machineId, clientId);
  }
  async setPassword(password: unknown, keepClient?: string): Promise<void> {
    const epoch = this.epoch;
    await this.password.set(password, () => epoch === this.epoch && (!keepClient || this.client(keepClient)?.kind === "browser"));
    this.epoch++; this.challenges.clear();
    // Changing a password ends other browser sessions, never file connectors.
    for (const client of this.clients()) if (client.kind === "browser" && client.id !== keepClient) this.revoke(client.id);
  }
  private session(name: string): Response {
    const credential = this.issue(name, "browser", null);
    return Response.json({ authenticated: true, clientId: credential.clientId }, { headers: { "set-cookie": cookie(SESSION, credential.token, Math.floor((credential.expiresAt - this.now()) / 1000)) } });
  }
  client(id: string): SharedClient | null {
    return this.options.db.query(`${selectClients} WHERE id=? AND revoked_at IS NULL AND expires_at>?`).get(id, this.now()) as SharedClient | null;
  }
  clients(): SharedClient[] { return this.options.db.query(`${selectClients} ORDER BY created_at DESC,id`).all() as SharedClient[]; }
  authenticate(request: Request): SharedClient | null {
    if (!this.enabled()) return null;
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (authorization && !bearer) return null;
    const raw = bearer ?? getCookie(request, SESSION); if (!raw) return null;
    const row = this.options.db.query(`${selectClients} WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(digest(raw), this.now()) as SharedClient | null;
    // A copied browser cookie cannot become an agent token, or the reverse.
    return row && (bearer ? row.kind !== "browser" : row.kind === "browser") ? row : null;
  }
  onRevoke(listener: (clientId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  revoke(id: string): boolean {
    const result = this.options.db.query("UPDATE shared_clients SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(this.now(), id);
    if (result.changes) for (const listener of this.listeners) listener(id);
    return result.changes > 0;
  }
  /** Privileged local call only. Never expose this operation through a public dispatch. */
  beginEnrollment({ replace = false }: { replace?: boolean } = {}): { code: string; expiresAt: number } {
    if (this.options.passkeys.enrolled() && !replace) throw new SharedAccessError("already_enrolled", "An owner passkey is already enrolled.", 409);
    if (replace && (!this.options.passkeys.recoveryOptions || !this.options.passkeys.replace)) throw new SharedAccessError("recovery_unsupported", "This passkey provider cannot recover owner access.", 409);
    const code = secret(), expiresAt = this.now() + FIVE_MINUTES;
    this.epoch++; this.challenges.clear();
    this.enrollment = { hash: digest(code), expires: expiresAt, replace, attempts: 0 };
    return { code, expiresAt };
  }
  private issue(name: string, kind: SharedClientKind, machineId: string | null, token = secret()): SharedCredential {
    const clientId = randomUUID(), createdAt = this.now(), expiresAt = createdAt + (kind === "browser" ? 30 : 90) * DAY;
    const replaced: string[] = [];
    this.options.db.transaction(() => {
      if (kind === "connector" && machineId) {
        const previous = this.options.db.query("SELECT id FROM shared_clients WHERE machine_id=? AND kind='connector' AND revoked_at IS NULL").all(machineId) as { id: string }[];
        this.options.db.query("UPDATE shared_clients SET revoked_at=? WHERE machine_id=? AND kind='connector' AND revoked_at IS NULL").run(createdAt, machineId);
        replaced.push(...previous.map(client => client.id));
      }
      this.options.db.query("INSERT INTO shared_clients(id,name,kind,machine_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").run(clientId, name, kind, machineId, digest(token), createdAt, expiresAt);
    })();
    for (const id of replaced) for (const listener of this.listeners) listener(id);
    return { origin: this.origin, clientId, machineId, token, expiresAt };
  }
  private expire(): void {
    for (const map of [this.pairings, this.challenges]) for (const [id, value] of map) if (value.expires <= this.now()) map.delete(id);
    if (this.enrollment && this.enrollment.expires <= this.now()) this.enrollment = undefined;
  }
  private limit(): void {
    const window = Math.floor(this.now() / 60_000);
    if (this.rate.window !== window) this.rate = { window, count: 0 };
    if (++this.rate.count > 60) throw new SharedAccessError("rate_limited", "Too many authentication attempts. Try again in a minute.", 429);
  }
  private async challenge(action: Challenge["action"], binding: string, properties: Pick<Challenge, "target" | "name"> = {}) {
    if (this.challenges.size >= 64) throw new SharedAccessError("rate_limited", "Too many pending authentication requests.", 429);
    const epoch = this.epoch;
    const options = action === "register" ? await this.options.passkeys.registrationOptions() : action === "replace"
      ? await this.options.passkeys.recoveryOptions!() : await this.options.passkeys.authenticationOptions();
    if (epoch !== this.epoch || this.challenges.size >= 64) deny();
    const id = secret(); this.challenges.set(id, { challenge: options.challenge, action, binding: digest(binding), expires: this.now() + CHALLENGE_MS, epoch, ...properties });
    return { id, options };
  }
  /** Auth routes only; the gateway also checks transport before calling this. */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith("/auth/")) return null;
    this.expire();
    if (!this.enabled()) throw new SharedAccessError("fly_disabled", "Tether Fly is disabled. Enable it through the hub’s local Settings.", 403);
    if (request.method !== "POST") return null;
    const body = await sharedJson(request);
    if (path === "/auth/pair/poll") {
      const pair = this.pairings.get(body.requestId);
      if (!pair || typeof body.pollSecret !== "string" || digest(body.pollSecret) !== pair.pollHash) deny();
      if (!pair.approved) return Response.json({ status: "pending", expiresAt: pair.expires });
      const token = createHash("sha256").update(`tether-pair-v1:${body.requestId}:${body.pollSecret}`).digest("base64url");
      let credential: SharedCredential;
      if (pair.clientId) {
        const client = this.client(pair.clientId); if (!client) deny();
        credential = { origin: this.origin, clientId: client.id, machineId: client.machineId, expiresAt: client.expiresAt, token };
      } else {
        this.options.db.transaction(() => {
          if (pair.kind === "connector" && pair.machineId) this.machines.set(pair.machineId, pair.machineName ?? this.machines.get(pair.machineId)?.name ?? pair.name, pair.qualifyPaths);
          credential = this.issue(pair.name, pair.kind, pair.machineId, token);
          pair.clientId = credential.clientId; this.pairings.set(body.requestId, pair);
        })();
      }
      return Response.json({ status: "approved", credential: credential! });
    }
    this.limit();
    if (path === "/auth/pair") {
      if (!this.options.passkeys.enrolled()) throw new SharedAccessError("owner_enrollment_required", "Establish the owner passkey at this HTTPS origin before pairing clients.", 409);
      if (this.pairings.size >= 32) throw new SharedAccessError("rate_limited", "Too many pending client requests.", 429);
      if (body.kind !== "agent" && body.kind !== "connector") throw new SharedAccessError("invalid_client", "Client kind must be agent or connector.", 400);
      if (body.machineId !== undefined && (typeof body.machineId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.machineId) || body.machineId === this.options.localMachineId)) throw new SharedAccessError("invalid_machine", "Choose an enrolled file-machine UUID; the service's own local machine cannot be paired.", 400);
      if (body.kind === "agent" && body.machineId && !this.machines.get(body.machineId)) deny("Choose an existing file machine for this agent.");
      if (body.qualifyPaths !== undefined && typeof body.qualifyPaths !== "boolean") deny();
      const name = label(body.name), requestId = secret(), pollSecret = secret(), code = randomBytes(5).toString("hex").toUpperCase(), expiresAt = this.now() + FIVE_MINUTES;
      this.pairings.set(requestId, { name, kind: body.kind, machineId: body.kind === "connector" ? body.machineId ?? randomUUID() : body.machineId ?? null, codeHash: digest(code), qualifyPaths: body.qualifyPaths, ...(body.machineName ? { machineName: label(body.machineName) } : {}), pollHash: digest(pollSecret), expires: expiresAt, attempts: 0, approved: false });
      return Response.json({ requestId, pollSecret, code, machineId: this.pairings.get(requestId)!.machineId, expiresAt, verificationUrl: `${this.origin}/auth/approve?request=${requestId}` });
    }
    if (request.headers.get("origin") !== this.origin) deny("The browser origin did not match this profile.");
    if (path === "/auth/password/login") {
      const epoch = this.epoch;
      if (!await this.password.verify(body.password) || epoch !== this.epoch || !this.enabled()) deny("Sign-in failed. Check your password or use your passkey.");
      return this.session(label(body.name ?? "Browser"));
    }
    if (path === "/auth/password/set") {
      const client = this.authenticate(request); if (client?.kind !== "browser") deny();
      await this.setPassword(body.password, client.id); return Response.json({ configured: true });
    }
    if (path === "/auth/session") {
      const client = this.authenticate(request); if (client?.kind !== "browser") deny();
      return Response.json({ client, clients: this.clients(), passwordConfigured: this.password.configured() });
    }
    if (path === "/auth/pair/context") {
      const pair = this.pairings.get(body.requestId); if (!pair) deny();
      return Response.json({ name: pair.name, kind: pair.kind, machineId: pair.machineId, machineName: pair.machineName ?? this.machines.get(pair.machineId ?? "")?.name, qualifyPaths: pair.qualifyPaths ?? this.machines.get(pair.machineId ?? "")?.qualifyPaths ?? false, replaces: pair.kind === "connector" && pair.machineId ? this.clients().filter(client => client.kind === "connector" && client.machineId === pair.machineId && client.revokedAt === null).map(client => client.name) : [], expiresAt: pair.expires });
    }
    if (path === "/auth/options") {
      const binding = secret(); let result;
      if (body.action === "register") {
        const enrollment = this.enrollment;
        if (!enrollment || ++enrollment.attempts > 5 || typeof body.code !== "string" || digest(body.code) !== enrollment.hash) deny();
        this.enrollment = undefined;
        result = await this.challenge(enrollment.replace ? "replace" : "register", binding);
      } else if (body.action === "approve") {
        const pair = this.pairings.get(body.requestId);
        if (pair) { pair.attempts++; this.pairings.set(body.requestId, pair); }
        if (!pair || pair.approved || pair.attempts > 5 || typeof body.code !== "string" || digest(body.code.toUpperCase().replaceAll("-", "")) !== pair.codeHash) deny("The client request or verification code is invalid or expired.");
        result = await this.challenge("approve", binding, { target: body.requestId });
      } else if (body.action === "login") result = await this.challenge("login", binding, { name: label(body.name ?? "Browser") });
      else if (body.action === "list") result = await this.challenge("list", binding);
      else if (body.action === "revoke" && typeof body.clientId === "string" && this.clients().some(client => client.id === body.clientId)) result = await this.challenge("revoke", binding, { target: body.clientId });
      else deny();
      return Response.json(result, { headers: { "set-cookie": cookie(BINDING, binding, CHALLENGE_MS / 1000) } });
    }
    if (path === "/auth/verify") {
      const challenge = this.challenges.get(body.challengeId); this.challenges.delete(body.challengeId);
      if (!challenge || challenge.binding !== digest(getCookie(request, BINDING)) || challenge.epoch !== this.epoch) deny();
      if (challenge.action === "register" || challenge.action === "replace") {
        if (challenge.action === "replace") await this.options.passkeys.replace!(challenge.challenge, body.response);
        else await this.options.passkeys.register(challenge.challenge, body.response);
        this.epoch++; this.challenges.clear(); this.pairings.clear();
        return Response.json({ enrolled: true, clients: this.clients() });
      }
      await this.options.passkeys.authenticate(challenge.challenge, body.response);
      if (challenge.epoch !== this.epoch || challenge.expires <= this.now()) deny();
      if (challenge.action === "approve") {
        const pair = this.pairings.get(challenge.target!); if (!pair || pair.expires <= this.now() || pair.approved) deny();
        pair.approved = true; this.pairings.set(challenge.target!, pair); return Response.json({ approved: true });
      }
      if (challenge.action === "list") return Response.json({ clients: this.clients() });
      if (challenge.action === "revoke") return Response.json({ revoked: this.revoke(challenge.target!), clients: this.clients() });
      return this.session(challenge.name!);
    }
    if (path === "/auth/logout") {
      const client = this.authenticate(request); if (client?.kind === "browser") this.revoke(client.id);
      return Response.json({ signedOut: true }, { headers: { "set-cookie": cookie(SESSION, "", 0) } });
    }
    return null;
  }
}
