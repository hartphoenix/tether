/**
 * Human-initiated turn signals, held in daemon memory per (canonical path, actor).
 * A press carries no content; it only tells one waiting agent that the human
 * started its next turn. Cursors name the daemon instance so a restart is visible.
 */
export type TurnSignal = { cursor: string; sequence: number; requestedAt: string; path: string; actor: string };
export type TurnWait = { turn: TurnSignal } | { turn: null; cursor: string } | { turn: null; stopped: true };
export type AgentState = "ready" | "working";
export type TurnAgent = { actor: string; label?: string; state: AgentState };
export type TurnPress = { cursor: string; sequence: number; actor: string };

/** A chained poll keeps an agent ready this long after a wait ends without a turn. */
export const READY_GRACE_MS = 60_000;
/** An agent that never re-arms after a press is dropped after this long. */
export const WORKING_LIMIT_MS = 2 * 60 * 60_000;
export const MAX_LABEL_LENGTH = 60;

type Agent = { actor: string; label?: string; sequence: number; requestedAt: string; state: AgentState; since: number; waiters: Set<() => void> };

const actorKey = (actor: string) => actor.trim().toLocaleLowerCase();

export class TurnSignals {
  private readonly paths = new Map<string, Map<string, Agent>>();
  private stopped = false;

  constructor(private readonly instanceId: string, private readonly now: () => number = Date.now) {}

  private cursor(sequence: number): string { return `${this.instanceId}:${sequence}`; }

  /** A cursor from another daemon instance, or a malformed one, counts as sequence 0. */
  sequenceOf(cursor: unknown): number {
    if (typeof cursor !== "string") return 0;
    const separator = cursor.lastIndexOf(":");
    if (separator < 0 || cursor.slice(0, separator) !== this.instanceId) return 0;
    const sequence = Number(cursor.slice(separator + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  }

  private present(agent: Agent): boolean {
    const elapsed = this.now() - agent.since;
    return agent.state === "working" ? elapsed <= WORKING_LIMIT_MS : agent.waiters.size > 0 || elapsed <= READY_GRACE_MS;
  }

  /** Current agents for a document; expired ones are dropped as they are observed. */
  private live(path: string): Map<string, Agent> {
    const agents = this.paths.get(path) ?? new Map<string, Agent>();
    for (const [key, agent] of agents) if (!this.present(agent)) agents.delete(key);
    if (!agents.size) this.paths.delete(path);
    return agents;
  }

  agents(path: string): TurnAgent[] {
    return [...this.live(path).values()]
      .map(({ actor, label, state }) => ({ actor, ...(label ? { label } : {}), state }))
      .sort((left, right) => left.actor.localeCompare(right.actor));
  }

  /** Registered agents keep the daemon alive, as an open host wait does. */
  waiting(): boolean {
    for (const path of [...this.paths.keys()]) if (this.live(path).size) return true;
    return false;
  }

  /** Wake one agent. Fails when that agent isn't registered or is still working. */
  request(path: string, actor: string): TurnPress | "unavailable" | "working" {
    const agent = this.live(path).get(actorKey(actor));
    if (!agent) return "unavailable";
    if (agent.state === "working") return "working";
    agent.sequence += 1;
    agent.requestedAt = new Date(this.now()).toISOString();
    agent.state = "working";
    agent.since = this.now();
    for (const wake of [...agent.waiters]) wake();
    return { cursor: this.cursor(agent.sequence), sequence: agent.sequence, actor: agent.actor };
  }

  /**
   * Arm `actor` on `path`. Resolves with a press newer than `after` (now, when
   * omitted), or with null at the timeout. Arming without an undelivered press
   * ends a working turn.
   */
  async wait(path: string, actor: string, label: string | undefined, after: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<TurnWait> {
    if (this.stopped) return { turn: null, stopped: true };
    const agents = this.live(path);
    this.paths.set(path, agents);
    const key = actorKey(actor);
    let agent = agents.get(key);
    // An agent dropped while its watcher was away (a sleeping laptop) resumes from its cursor,
    // so the next press is newer than anything it has already seen.
    if (!agent) agents.set(key, agent = { actor: actor.trim(), sequence: this.sequenceOf(after), requestedAt: "", state: "ready", since: this.now(), waiters: new Set() });
    agent.label = label;
    const since = after === undefined ? agent.sequence : this.sequenceOf(after);
    const current = agent;
    const result = (): TurnWait => this.stopped && current.sequence <= since ? { turn: null, stopped: true }
      : current.sequence > since
        ? { turn: { cursor: this.cursor(current.sequence), sequence: current.sequence, requestedAt: current.requestedAt, path, actor: current.actor } }
        : { turn: null, cursor: this.cursor(Math.max(since, current.sequence)) };
    if (agent.sequence > since) return result();
    agent.state = "ready";
    agent.since = this.now();
    if (timeoutMs > 0 && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          current.waiters.delete(finish);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        current.waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    // The ready grace runs from the end of the latest poll.
    if (current.state === "ready") current.since = this.now();
    return result();
  }

  /** Release every open wait. A deliberate stop tells agents not to reconnect. */
  close(deliberate = false): void {
    if (deliberate) this.stopped = true;
    for (const agents of this.paths.values()) for (const agent of agents.values()) for (const finish of [...agent.waiters]) finish();
  }
}
