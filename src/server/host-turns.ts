import type { Database } from "bun:sqlite";

import type { TurnBehavior, HostSubscription, HostSignal } from "../../integrations/paseo/shared/turns";
export type { TurnBehavior, HostSubscription, HostSignal } from "../../integrations/paseo/shared/turns";
type Lease = { instance: string; token: string; until: number };
const fail = (message: string, status = 409) => Object.assign(new Error(message), { code: "turn_conflict", status });
const key = (documentId: string, agentId: string) => JSON.stringify([documentId, agentId]);
const recipient = (subscription: HostSubscription) => subscription.recipientId ?? subscription.agentId;

/** Durable human invitations. A claimed send is never implicitly replayed. */
export class HostTurns {
  private listeners = new Set<() => void>();
  private leases = new Map<string, Lease>();
  private revision: number;
  constructor(private db: Database, private now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS host_turn_subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_turn_signals (id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_turn_behaviors (id TEXT PRIMARY KEY, behavior TEXT NOT NULL);
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
    if (existing && recipient(existing) !== recipient(input)) throw fail("Use role takeover to change the receiving session.");
    const preference = this.db.query("SELECT behavior FROM host_turn_behaviors WHERE id=?").get(JSON.stringify([input.owner, input.hostId, recipient(input)])) as { behavior: TurnBehavior } | null;
    const subscription = { ...input, availability: existing?.availability, behavior: preference?.behavior ?? existing?.behavior ?? input.behavior, signalId: existing?.signalId };
    this.db.query("INSERT INTO host_turn_subscriptions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(key(input.documentId, input.agentId), JSON.stringify(subscription));
    this.changed();
    return subscription;
  }
  /** Rebind every document without replaying invitations sent to the previous session. */
  takeOver(agentId: string, recipientId: string, hostId: string, owner: string, expectedRecipient: string): void {
    const subscriptions = this.subscriptions().filter(s => s.agentId === agentId);
    if (!subscriptions.length) throw fail("This role has no Go registration.");
    for (const s of subscriptions) {
      if (s.owner !== owner) throw fail("This role belongs to a different connection.", 403);
      if (recipient(s) !== expectedRecipient && !(recipient(s) === recipientId && s.hostId === hostId)) throw fail("The role changed. Copy a fresh role takeover prompt.");
    }
    this.db.transaction(() => {
      for (const s of subscriptions) {
        if (recipient(s) === recipientId && s.hostId === hostId) continue;
        const signal = s.signalId && this.signal(s.signalId);
        if (signal && !["completed", "failed"].includes(signal.state)) {
          signal.state = "failed";
          signal.reason = "Role taken over; invitation retired without replay. The previous session may already have received it.";
          this.saveSignal(signal);
        }
        const next = { ...s, recipientId, hostId, signalId: undefined, availability: undefined };
        this.db.query("UPDATE host_turn_subscriptions SET payload=? WHERE id=?").run(JSON.stringify(next), key(s.documentId, agentId));
      }
    })();
    this.changed();
  }
  /** Upgrade an old host registration without replaying any historical send. */
  adopt(input: HostSubscription, previous?: { signalId: string; acceptedAt?: string; reason?: string; requestedAt?: string }): void {
    if (this.subscriptions().some(s => s.documentId === input.documentId && s.agentId === input.agentId)) return;
    this.register(input);
    if (!previous) return;
    const signal: HostSignal = { ...input, ...previous, operationId: `legacy:${previous.signalId}`, state: "uncertain",
      requestedAt: previous.requestedAt ?? new Date(this.now()).toISOString(), text: "",
      reason: previous.reason ?? "Previous host delivery needs acceptance review; no resend attempted." };
    this.saveSignal(signal);
    this.db.query("UPDATE host_turn_subscriptions SET payload=? WHERE id=?").run(JSON.stringify({ ...input, signalId: signal.signalId }), key(input.documentId, input.agentId));
    this.changed();
  }
  unregister(documentId: string, agentId: string, owner?: string): boolean {
    const subscription = this.subscriptions().find(s => s.documentId === documentId && s.agentId === agentId);
    if (!subscription) return false;
    if (owner && owner !== "local" && subscription.owner !== owner) throw fail("This registration belongs to a different connection.", 403);
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
      const state = s.availability ? "unavailable" : !signal || signal.state === "completed" || signal.state === "failed" ? "ready" : signal.state === "pending" ? "queued"
        : signal.state === "accepted" ? "working" : "unavailable";
      return { agentId: s.agentId, label: s.label, behavior: signal && !["completed", "failed"].includes(signal.state) ? signal.behavior : s.behavior, state, signalId: signal?.signalId, acceptedAt: signal?.acceptedAt,
        reason: s.availability ?? signal?.reason ?? (signal?.state === "dispatching" ? "Confirming host acceptance" : undefined) };
    });
  }
  lease(owner: string, hostId: string, instance: string): { token: string; until: number } {
    const id = key(owner, hostId), lease = this.leases.get(id);
    if (lease && lease.until > this.now() && lease.instance !== instance) throw fail("Another adapter owns this host connection.");
    const next = { instance, token: lease?.instance === instance ? lease.token : crypto.randomUUID(), until: this.now() + 45_000 };
    this.leases.set(id, next);
    return next;
  }
  release(owner: string, hostId: string, token: string): void {
    const id = key(owner, hostId);
    if (this.leases.get(id)?.token === token) this.leases.delete(id);
  }
  private checkLease(owner: string, hostId: string, token: string): void {
    const lease = this.leases.get(key(owner, hostId));
    if (!lease || lease.token !== token || lease.until <= this.now()) throw fail("The host lease expired.");
  }
  verify(owner: string, hostId: string, token: string, signalId: string): void {
    this.checkLease(owner, hostId, token);
    const signal = this.signal(signalId);
    if (!signal || signal.owner !== owner || signal.hostId !== hostId || signal.state !== "dispatching" || !this.subscriptions().some(s => s.signalId === signalId)) throw fail("Signal is no longer dispatchable.");
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
      if (this.snapshot(owner, hostId).signals.some(s => s.signalId !== signalId && recipient(s) === recipient(signal) && s.state !== "pending")) throw fail("Another document has an active delivery to this agent.");
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
  availability(owner: string, hostId: string, token: string, agentId: string, reason?: string): void {
    this.checkLease(owner, hostId, token);
    for (const s of this.subscriptions().filter(s => s.owner === owner && s.hostId === hostId && recipient(s) === agentId)) {
      if (s.availability === reason) continue;
      s.availability = reason;
      this.db.query("UPDATE host_turn_subscriptions SET payload=? WHERE id=?").run(JSON.stringify(s), key(s.documentId, s.agentId));
      this.changed();
    }
  }
  behavior(owner: string, hostId: string, agentId: string, behavior: TurnBehavior): void {
    this.db.query("INSERT INTO host_turn_behaviors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET behavior=excluded.behavior").run(JSON.stringify([owner, hostId, agentId]), behavior);
    for (const subscription of this.subscriptions().filter(s => s.owner === owner && s.hostId === hostId && recipient(s) === agentId)) this.register({ ...subscription, behavior });
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
