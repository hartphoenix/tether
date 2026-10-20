import type { HostSignal } from "../shared/turns";
import type { Position, TurnAgentHandle, TurnHost } from "./turn-sdk";
import type { TurnSnapshot, TurnTransport } from "./turn-transport";
import { hasCompletedReceipt } from "../chat/receipts";

const delay = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  if (signal.aborted) done();
});

/** Bounded recipient-log recovery. Missing entries never authorize resending. */
export async function findTurnInput(agent: TurnAgentHandle, signal: HostSignal): Promise<boolean> {
  const matches = (page: Awaited<ReturnType<TurnAgentHandle["timeline"]["refetch"]>>) => page.entries.some(({ item }) =>
    item.type === "user_message" && (item.clientMessageId === signal.signalId || item.messageId === signal.signalId || item.text?.includes(`signal-id="${signal.signalId}"`)));
  const latest = await agent.timeline.refetch({ direction: "tail", limit: 1, projection: "canonical" });
  if (matches(latest)) return true;
  let position = signal.position as Position | undefined;
  if (!position || typeof position.epoch !== "string" || !Number.isSafeInteger(position.seq) || position.epoch !== latest.epoch) return false;
  for (let page = 0; page < 8; page++) {
    const result = await agent.timeline.refetch({ direction: "after", cursor: position, limit: 128, projection: "canonical" });
    if (result.epoch !== position.epoch) return false;
    if (matches(result)) return true;
    if (!result.hasNewer || !result.endCursor || result.endCursor.seq <= position.seq) break;
    position = result.endCursor;
  }
  return false;
}

/** A plugin-owned event consumer. No timer invokes a model or repeats a send. */
export class TurnDispatcher {
  private snapshot: TurnSnapshot = { revision: -1, subscriptions: [], signals: [] };
  private watchers = new Map<string, () => void>();
  private active = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  constructor(private host: TurnHost, private transport: TurnTransport, private token: () => string, private lifetime: AbortSignal,
    private recoveryDelays = [250, 1000, 2000, 4000], private onFailure: () => void = () => {}) {}
  update(snapshot: TurnSnapshot): void {
    if (this.lifetime.aborted || snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot;
    const agents = new Set(snapshot.subscriptions.map(s => s.recipientId ?? s.agentId));
    for (const [id, off] of this.watchers) if (!agents.has(id)) { off(); this.watchers.delete(id); }
    for (const id of agents) {
      if (!this.watchers.has(id)) this.watchers.set(id, this.host.agent(id.slice(6)).subscribe(() => this.wake(id)));
      this.wake(id);
    }
  }
  wake(agentId: string): void {
    if (this.lifetime.aborted) return;
    if (this.active.has(agentId)) { this.rerun.add(agentId); return; }
    const task = this.reconcile(agentId).catch(() => { if (!this.lifetime.aborted) this.onFailure(); }).finally(() => {
      this.active.delete(agentId);
      if (this.rerun.delete(agentId)) this.wake(agentId);
    });
    this.active.set(agentId, task);
  }
  private current(signal: HostSignal): boolean {
    return !this.lifetime.aborted && this.snapshot.signals.some(s => s.signalId === signal.signalId) && this.snapshot.subscriptions.some(s => s.signalId === signal.signalId);
  }
  private async receipt(signal: HostSignal, action: string, input: Record<string, unknown> = {}): Promise<HostSignal> {
    this.lifetime.throwIfAborted();
    return this.transport.command({ hostId: this.host.hostId, token: this.token(), signalId: signal.signalId, action, ...input });
  }
  private async accepted(agent: TurnAgentHandle, signal: HostSignal): Promise<boolean> {
    try { if (await findTurnInput(agent, signal)) return true; } catch { /* A durable receipt is independent evidence. */ }
    return hasCompletedReceipt(this.host.home, this.host.hostId, (signal.recipientId ?? signal.agentId).slice(6), {
      id: signal.signalId, messageId: signal.signalId, state: "dispatching", text: signal.text, prose: "", attachments: [], draftIds: [],
      wire: JSON.stringify({ text: signal.text, options: { messageId: signal.signalId, activeTurnBehavior: signal.behavior === "queue" ? "steer" : signal.behavior } }),
    });
  }
  private async recover(agent: TurnAgentHandle, signal: HostSignal): Promise<boolean> {
    for (const ms of this.recoveryDelays) {
      await delay(ms, this.lifetime);
      if (!this.current(signal)) return false;
      try { if (await this.accepted(agent, signal)) return true; } catch { /* Retry only the read. */ }
    }
    return false;
  }
  private async reconcile(agentId: string): Promise<void> {
    const signals = this.snapshot.signals.filter(s => (s.recipientId ?? s.agentId) === agentId).sort((a, b) => (a.state === "pending" ? 1 : 0) - (b.state === "pending" ? 1 : 0) || a.requestedAt.localeCompare(b.requestedAt));
    const agent = this.host.agent(agentId.slice(6));
    const initial = (await agent.refresh())?.agent;
    const reason = !initial || initial.archivedAt ? "Paseo agent is missing or archived." : initial.pendingPermissions?.length ? "Paseo agent is waiting for permission." : !["idle", "running"].includes(initial.status) ? "Paseo agent is unavailable." : undefined;
    await this.transport.command({ action: "availability", hostId: this.host.hostId, token: this.token(), agentId, ...(reason ? { reason } : {}) });
    if (reason) return;
    for (let signal of signals) {
      if (!this.current(signal)) continue;
      let snapshot = (await agent.refresh())?.agent;
      if (!snapshot || snapshot.archivedAt) {
        if (signal.state !== "pending") await this.receipt(signal, "uncertain", { reason: "Paseo agent is missing or archived." });
        continue;
      }
      if (snapshot.pendingPermissions?.length) continue;
      if (signal.state === "pending") {
        if (signal.behavior === "queue" && snapshot.status !== "idle") return;
        if (!["idle", "running"].includes(snapshot.status)) continue;
        const page = await agent.timeline.refetch({ direction: "tail", limit: 1, projection: "canonical" });
        if (!this.current(signal)) continue;
        signal = await this.receipt(signal, "claim", { position: page.endCursor ?? { epoch: page.epoch, seq: 0 } });
        if (this.lifetime.aborted) return;
        // Verify the lease immediately before crossing the host acceptance boundary.
        // A competing adapter sees "dispatching" and can only reconcile.
        try {
          await this.transport.command({ hostId: this.host.hostId, token: this.token(), signalId: signal.signalId, action: "verify" });
          this.lifetime.throwIfAborted();
          await agent.send(signal.text, { messageId: signal.signalId, activeTurnBehavior: signal.behavior === "queue" ? "steer" : signal.behavior });
          signal = await this.receipt(signal, "accepted");
        } catch {
          const found = await this.recover(agent, signal);
          if (!found) { await this.receipt(signal, "uncertain", { reason: "Host acceptance could not be established; no resend attempted." }); return; }
          signal = await this.receipt(signal, "accepted");
        }
      } else if (signal.state === "dispatching" || signal.state === "uncertain") {
        if (!await this.recover(agent, signal)) {
          if (signal.state === "dispatching" && this.current(signal)) await this.receipt(signal, "uncertain", { reason: "Host acceptance remains uncertain; no resend attempted." });
          return;
        }
        signal = await this.receipt(signal, "accepted");
      }
      if (signal.state === "accepted") {
        snapshot = (await agent.refresh())?.agent;
        if (snapshot?.status === "idle" && !snapshot.pendingPermissions?.length && await findTurnInput(agent, signal)) {
          await this.receipt(signal, snapshot.lastError ? "failed" : "completed", snapshot.lastError ? { reason: "Paseo reported a failed turn. Review the agent conversation." } : {});
        }
      }
      return; // The next authoritative snapshot releases the next document for this agent.
    }
  }
  async settled(): Promise<void> { await Promise.all([...this.active.values()]); }
  stop(): void { for (const off of this.watchers.values()) off(); this.watchers.clear(); }
}

export { delay as waitForTurnConnection };
