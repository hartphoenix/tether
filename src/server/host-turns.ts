import type { Database } from "bun:sqlite";

export type TurnBehavior = "steer" | "interrupt" | "queue";
export type HostSubscription = {
  documentId: string; path: string; machineId: string; agentId: string; hostId: string;
  owner: string; label?: string; behavior: TurnBehavior; signalId?: string;
};
export type HostSignal = HostSubscription & {
  signalId: string; operationId: string; requestedAt: string; text: string;
  state: "pending" | "dispatching" | "accepted" | "completed" | "failed" | "uncertain";
  acceptedAt?: string; reason?: string; position?: unknown;
};
type Lease = { instance: string; token: string; until: number };
const fail = (message: string, status = 409) => Object.assign(new Error(message), { code: "turn_conflict", status });
const key = (documentId: string, agentId: string) => JSON.stringify([documentId, agentId]);

/** Durable human invitations. A claimed send is never implicitly replayed. */
export class HostTurns {
  private listeners = new Set<() => void>();
  private leases = new Map<string, Lease>();
  private revision: number;
  constructor(private db: Database, private now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS host_turn_subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_turn_signals (id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_turn_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO host_turn_meta VALUES(1,0);`);
    this.revision = (db.query("SELECT revision FROM host_turn_meta").get() as { revision: number }).revision;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void {
    this.db.query("UPDATE host_turn_meta SET revision=revision+1").run();
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  subscriptions(): HostSubscription[] {
    return (this.db.query("SELECT payload FROM host_turn_subscriptions").all() as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  signal(id: string): HostSignal | undefined {
    const row = this.db.query("SELECT payload FROM host_turn_signals WHERE id=?").get(id) as { payload: string } | null;
    return row ? JSON.parse(row.payload) : undefined;
  }
  private saveSignal(signal: HostSignal): void {
    this.db.query("INSERT INTO host_turn_signals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(signal.signalId, signal.operationId, JSON.stringify(signal));
  }
  register(input: HostSubscription): HostSubscription {
    const existing = this.subscriptions().find(s => s.documentId === input.documentId && s.agentId === input.agentId);
    if (existing && (existing.hostId !== input.hostId || existing.owner !== input.owner)) throw fail("The agent is registered to a different host connection.");
    const subscription = { ...input, signalId: existing?.signalId };
    this.db.query("INSERT INTO host_turn_subscriptions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(key(input.documentId, input.agentId), JSON.stringify(subscription));
    this.changed();
    return subscription;
  }
  unregister(documentId: string, agentId: string, owner?: string): boolean {
    const subscription = this.subscriptions().find(s => s.documentId === documentId && s.agentId === agentId);
    if (!subscription) return false;
    if (owner && subscription.owner !== owner) throw fail("This registration belongs to a different connection.", 403);
    const signal = subscription.signalId && this.signal(subscription.signalId);
    if (signal && !["completed", "failed"].includes(signal.state)) {
      signal.state = "failed"; signal.reason = "Registration removed; delivery may already have been accepted.";
      this.saveSignal(signal);
    }
    this.db.query("DELETE FROM host_turn_subscriptions WHERE id=?").run(key(documentId, agentId));
    this.changed();
    return true;
  }
  request(documentId: string, agentId: string, operationId: string, capture?: (s: HostSignal) => string): HostSignal {
    const prior = this.db.query("SELECT payload FROM host_turn_signals WHERE operation_id=?").get(operationId) as { payload: string } | null;
    if (prior) {
      const signal = JSON.parse(prior.payload) as HostSignal;
      if (signal.documentId !== documentId || signal.agentId !== agentId) throw fail("Operation ID was already used for a different turn.");
      return signal;
    }
    const subscription = this.subscriptions().find(s => s.documentId === documentId && s.agentId === agentId);
    if (!subscription) throw fail("This agent is not registered on the document.");
    const previous = subscription.signalId && this.signal(subscription.signalId);
    if (previous && !["completed", "failed"].includes(previous.state)) throw fail("The previous turn still needs completion or delivery review.");
    const signalId = crypto.randomUUID();
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const signal: HostSignal = { ...subscription, signalId, operationId, state: "pending", requestedAt: new Date(this.now()).toISOString(),
      text: `<tether-turn path="${xml(subscription.path)}" document-id="${xml(documentId)}" signal-id="${signalId}" />` };
    this.db.transaction(() => {
      if (capture) signal.text = capture(signal);
      this.saveSignal(signal);
      subscription.signalId = signalId;
      this.db.query("UPDATE host_turn_subscriptions SET payload=? WHERE id=?").run(JSON.stringify(subscription), key(documentId, agentId));
    })();
    this.changed();
    return signal;
  }
  agents(documentId: string) {
    return this.subscriptions().filter(s => s.documentId === documentId).map(s => {
      const signal = s.signalId ? this.signal(s.signalId) : undefined;
      const state = !signal || signal.state === "completed" ? "ready" : signal.state === "pending" ? "queued"
        : signal.state === "accepted" ? "working" : "unavailable";
      return { agentId: s.agentId, label: s.label, behavior: s.behavior, state, signalId: signal?.signalId, acceptedAt: signal?.acceptedAt,
        reason: signal?.reason ?? (signal?.state === "dispatching" ? "Confirming host acceptance" : undefined) };
    });
  }
  lease(owner: string, hostId: string, instance: string): { token: string; until: number } {
    const id = key(owner, hostId), lease = this.leases.get(id);
    if (lease && lease.until > this.now() && lease.instance !== instance) throw fail("Another adapter owns this host connection.");
    const next = { instance, token: lease?.instance === instance ? lease.token : crypto.randomUUID(), until: this.now() + 45_000 };
    this.leases.set(id, next);
    return next;
  }
  private checkLease(owner: string, hostId: string, token: string): void {
    const lease = this.leases.get(key(owner, hostId));
    if (!lease || lease.token !== token || lease.until <= this.now()) throw fail("The host lease expired.");
  }
  snapshot(owner: string, hostId: string) {
    const subscriptions = this.subscriptions().filter(s => s.owner === owner && s.hostId === hostId);
    return { revision: this.revision, subscriptions, signals: subscriptions.flatMap(s => {
      const signal = s.signalId && this.signal(s.signalId);
      return signal && !["completed", "failed"].includes(signal.state) ? [signal] : [];
    }) };
  }
  update(owner: string, hostId: string, token: string, signalId: string, action: "claim" | "accepted" | "completed" | "failed" | "uncertain", input: { position?: unknown; reason?: string } = {}): HostSignal {
    this.checkLease(owner, hostId, token);
    const signal = this.signal(signalId);
    if (!signal || signal.owner !== owner || signal.hostId !== hostId) throw fail("Signal does not belong to this host connection.", 403);
    const current = this.subscriptions().find(s => s.documentId === signal.documentId && s.agentId === signal.agentId);
    if (current?.signalId !== signalId) throw fail("Signal is no longer current.");
    if (action === "claim") {
      if (signal.state !== "pending") throw fail("Signal was already claimed; inspect acceptance instead of sending again.");
      // Different documents must not dispatch concurrent turns to the same agent.
      if (this.snapshot(owner, hostId).signals.some(s => s.signalId !== signalId && s.agentId === signal.agentId && s.state !== "pending")) throw fail("Another document has an active delivery to this agent.");
      signal.state = "dispatching"; signal.position = input.position;
    } else if (action === "accepted") {
      if (!["dispatching", "uncertain", "accepted"].includes(signal.state)) throw fail("Signal is not awaiting acceptance.");
      signal.state = "accepted"; signal.acceptedAt ??= new Date(this.now()).toISOString(); delete signal.reason;
    } else if (action === "completed") {
      if (signal.state !== "accepted" && signal.state !== "completed") throw fail("Completion requires confirmed acceptance.");
      signal.state = "completed"; delete signal.reason;
    } else {
      if (signal.state === "completed" || signal.state === "failed") return signal;
      signal.state = action; signal.reason = input.reason?.slice(0, 400) ?? "The host could not establish the turn outcome.";
    }
    this.saveSignal(signal); this.changed(); return signal;
  }
  behavior(owner: string, hostId: string, agentId: string, behavior: TurnBehavior): void {
    for (const subscription of this.subscriptions().filter(s => s.owner === owner && s.hostId === hostId && s.agentId === agentId)) this.register({ ...subscription, behavior });
  }
  revoke(owner: string): void { for (const id of this.leases.keys()) if (JSON.parse(id)[0] === owner) this.leases.delete(id); }
}

/** Snapshots recover every durable state transition; event IDs are resume hints, not acknowledgements. */
export function turnEventStream(signal: AbortSignal, subscribe: (fn: () => void) => () => void, snapshot: () => unknown, live: () => boolean = () => true): Response {
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const encoder = new TextEncoder();
      const send = () => {
        if (closed) return;
        if (!live()) return close();
        const value = snapshot() as { revision?: number };
        controller.enqueue(encoder.encode(`id: ${value.revision ?? 0}\nevent: turns\ndata: ${JSON.stringify(value)}\n\n`));
      };
      const off = subscribe(send);
      const timer = setInterval(() => { if (!live()) close(); else if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
      close = () => { if (closed) return; closed = true; clearInterval(timer); off(); signal.removeEventListener("abort", close); try { controller.close(); } catch {} };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close(); else send();
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
