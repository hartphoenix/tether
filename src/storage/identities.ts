import type { Database } from "bun:sqlite";
import {
  ACTIVE_AGENT_MS, AGENT_COLOR_COUNT, AGENT_ICON_NAMES, HUMAN_ID, MAX_AGENT_ID_LENGTH, MAX_AGENT_NAME_LENGTH,
  isHumanId, nameKey, type Identity,
} from "../shared/agent-identity";

type Row = { id: string; name: string; name_source: "agent" | "human"; icon: string; color_slot: number; kind: "agent"; created_at: number; last_seen_at: number | null };

export type AgentClaim = { identity: Identity; created: boolean; nameKept: boolean };

function fail(code: string, message: string, status: number): never {
  throw Object.assign(new Error(message), { code, status, details: { outcome: "not_applied" } });
}

const toIdentity = (row: Row): Identity => ({ id: row.id, name: row.name, icon: row.icon, colorSlot: row.color_slot, kind: "agent" });
const humanIdentity: Identity = { id: HUMAN_ID, name: HUMAN_ID, icon: null, colorSlot: null, kind: "human" };

export function validAgentId(id: unknown): string {
  if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > MAX_AGENT_ID_LENGTH || /\p{Cc}/u.test(id)) fail("invalid_agent_id", `An agent ID is 1–${MAX_AGENT_ID_LENGTH} characters without surrounding spaces or control characters.`, 400);
  return id;
}

function validName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().normalize("NFC") : "";
  if (!value || value.length > MAX_AGENT_NAME_LENGTH || /\p{Cc}/u.test(value)) fail("invalid_agent_name", `An agent name is 1–${MAX_AGENT_NAME_LENGTH} characters without control characters.`, 400);
  if (isHumanId(value)) fail("agent_name_reserved", `"${HUMAN_ID}" is reserved for the human reader.`, 409);
  return value;
}

/**
 * Agent identities in the private store. IDs never change; names do, and a name
 * the human chose outranks the agent's own `--actor`. Each identity keeps the
 * icon and color it was given, so old messages look as they did.
 */
export class Identities {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_source TEXT NOT NULL CHECK(name_source IN ('agent','human')),
      icon TEXT NOT NULL, color_slot INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind IN ('agent','human')),
      created_at INTEGER NOT NULL, last_seen_at INTEGER);
      INSERT OR IGNORE INTO settings(key,value) VALUES ('identity_revision','0');`);
  }

  /** Changes whenever a name, icon or color the reader shows could change. */
  revision(): number {
    return Number((this.db.query("SELECT value FROM settings WHERE key='identity_revision'").get() as { value: string }).value);
  }

  private bump(): void {
    this.db.query("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='identity_revision'").run();
  }

  private row(id: string): Row | null {
    return this.db.query("SELECT * FROM identities WHERE id=?").get(id) as Row | null;
  }

  private rows(): Row[] { return this.db.query("SELECT * FROM identities").all() as Row[]; }

  private conflict(name: string, id: string, now: number): Row | undefined {
    const key = nameKey(name);
    return this.rows().find(row => row.id !== id && row.last_seen_at !== null && row.last_seen_at >= now - ACTIVE_AGENT_MS && nameKey(row.name) === key);
  }

  /** Least recently used icon no active agent holds, else the least recently used of all; then a color unlike that icon's last holder. */
  private assignment(now: number): { icon: string; colorSlot: number } {
    const rows = this.rows();
    const used = (row: Row) => row.last_seen_at ?? row.created_at;
    const held = new Set(rows.filter(row => row.last_seen_at !== null && row.last_seen_at >= now - ACTIVE_AGENT_MS).map(row => row.icon));
    const lastUse = new Map<string, Row>();
    for (const row of rows) if (!lastUse.has(row.icon) || used(row) > used(lastUse.get(row.icon)!)) lastUse.set(row.icon, row);
    const free = AGENT_ICON_NAMES.filter(icon => !held.has(icon));
    const pool = free.length ? free : [...AGENT_ICON_NAMES];
    const age = (icon: string) => { const holder = lastUse.get(icon); return holder ? used(holder) : -Infinity; };
    const icon = pool.reduce((best, next) => age(next) < age(best) ? next : best);
    const excluded = lastUse.get(icon)?.color_slot;
    const colorUse = new Map<number, number>();
    for (const row of rows) colorUse.set(row.color_slot, Math.max(colorUse.get(row.color_slot) ?? -Infinity, used(row)));
    const slots = Array.from({ length: AGENT_COLOR_COUNT }, (_, index) => index + 1).filter(slot => slot !== excluded);
    const colorSlot = slots.reduce((best, next) => (colorUse.get(next) ?? -Infinity) < (colorUse.get(best) ?? -Infinity) ? next : best);
    return { icon, colorSlot };
  }

  private insert(id: string, name: string, now: number, lastSeen: number | null): Row {
    const { icon, colorSlot } = this.assignment(now);
    this.db.query("INSERT INTO identities(id,name,name_source,icon,color_slot,kind,created_at,last_seen_at) VALUES(?,?,'agent',?,?,'agent',?,?)")
      .run(id, name, icon, colorSlot, now, lastSeen);
    this.bump();
    return this.row(id)!;
  }

  /** A fresh daemon-issued ID for an agent whose host offers none. */
  issue(): string {
    let id: string;
    do id = `tether:${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`; while (this.row(id));
    return id;
  }

  /**
   * An agent's command: register or touch `id`, and adopt `name` unless the
   * human named this agent. A name another active agent holds is refused.
   */
  claim(id: string, requestedName: string, now = Date.now()): AgentClaim {
    validAgentId(id);
    if (isHumanId(id)) fail("agent_id_reserved", `"${HUMAN_ID}" is reserved for the human reader.`, 409);
    const name = validName(requestedName);
    return this.db.transaction((): AgentClaim => {
      const existing = this.row(id);
      const keep = existing?.name_source === "human";
      if (!keep && existing?.name !== name) {
        const holder = this.conflict(name, id, now);
        if (holder) fail("agent_name_taken", `Another active agent is already named "${holder.name}". Choose a name for your role that's easy to tell apart from it, and pass it with --actor. If Tether issued you an agent ID earlier, pass that with --agent-id.`, 409);
      }
      if (!existing) return { identity: toIdentity(this.insert(id, name, now, now)), created: true, nameKept: false };
      if (!keep && existing.name !== name) {
        this.db.query("UPDATE identities SET name=? WHERE id=?").run(name, id);
        this.bump();
      }
      this.db.query("UPDATE identities SET last_seen_at=? WHERE id=?").run(now, id);
      return { identity: toIdentity(this.row(id)!), created: false, nameKept: keep && existing.name !== name };
    }).immediate();
  }

  /** Mark a known agent seen without naming it. Unknown IDs are ignored. */
  touch(id: string, now = Date.now()): void {
    this.db.query("UPDATE identities SET last_seen_at=? WHERE id=?").run(now, id);
  }

  /** Remove an identity created for a command that then failed, so its name is free again. */
  discard(id: string): void {
    if (this.db.query("DELETE FROM identities WHERE id=?").run(id).changes) this.bump();
  }

  /** The human renames an agent. The name then outranks the agent's own `--actor`. */
  rename(id: string, requestedName: string, now = Date.now()): Identity {
    validAgentId(id);
    if (isHumanId(id)) fail("agent_id_reserved", "The human reader's name can't be changed here.", 409);
    const name = validName(requestedName);
    return this.db.transaction((): Identity => {
      if (!this.row(id)) this.insert(id, id, now, null);
      const holder = this.conflict(name, id, now);
      if (holder) fail("agent_name_taken", `Another active agent is already named "${holder.name}". Choose a name that's easy to tell apart.`, 409);
      this.db.query("UPDATE identities SET name=?,name_source='human' WHERE id=?").run(name, id);
      this.bump();
      return toIdentity(this.row(id)!);
    }).immediate();
  }

  /**
   * Identities for every requested ID. Unknown IDs and legacy plain strings are
   * registered on first sight with their ID as name, without counting as seen.
   */
  resolve(ids: readonly string[], now = Date.now()): Identity[] {
    return this.db.transaction(() => ids.map(id => {
      if (isHumanId(id)) return humanIdentity;
      if (!id.trim()) fail("invalid_agent_id", "An identity ID can't be empty.", 400);
      return toIdentity(this.row(id) ?? this.insert(id, id.trim(), now, null));
    })).immediate();
  }
}
