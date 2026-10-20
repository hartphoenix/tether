import type { HostTurnDelivery } from "../hosts/host-adapter";
import type { TurnAnnotations } from "./turn-annotations";
import type { TurnStore } from "./turn-store";

export type TurnSignal = { signalId: string; cursor: string; sequence: number; requestedAt: string; path: string; agentId: string };
export type TurnWait = ({ turn: TurnSignal; annotations?: string } | { turn: null; cursor: string } | { turn: null; stopped: true });
export type AgentState = "ready" | "working" | "queued" | "unavailable";
export type TurnAgent = { agentId: string; label?: string; state: AgentState; reason?: string; signalId?: string; acceptedAt?: string };
export type TurnPress = { signalId: string; cursor: string; sequence: number; agentId: string; state: AgentState; reason?: string };
export const READY_GRACE_MS = 60_000;
export const WORKING_LIMIT_MS = 2 * 60 * 60_000;
export const MAX_LABEL_LENGTH = 60;

type Agent = TurnAgent & {
  sequence: number; requestedAt: string; since: number; waiters: Set<() => void>;
  registered?: boolean; controller?: AbortController; checkedAt?: number;
  annotations?: TurnAnnotations; via?: "watcher" | "host";
};
type Options = {
  delivery?: HostTurnDelivery;
  store?: TurnStore;
  capture?: (agentId: string, signalId: string, event: string) => TurnAnnotations;
  acknowledgeAnnotations?: (agentId: string, signalId: string) => void;
};

/** One human press per document/agent. Durable records describe outcomes, never replay work. */
export class TurnSignals {
  private readonly paths = new Map<string, Map<string, Agent>>();
  private readonly hostTails = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  private stopped = false;
  private listeners = new Set<() => void>();
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  constructor(private readonly instanceId: string, private readonly now: () => number = Date.now, private readonly options: Options = {}) {
    for (const saved of options.store?.restore() ?? []) {
      const agents = this.paths.get(saved.path) ?? new Map<string, Agent>();
      agents.set(saved.agentId, { ...saved, registered: true, sequence: 0, requestedAt: "", since: now(), waiters: new Set() });
      this.paths.set(saved.path, agents);
    }
  }
  private cursor(sequence: number): string { return `${this.instanceId}:${sequence}`; }
  sequenceOf(cursor: unknown): number {
    if (typeof cursor !== "string") return 0;
    const separator = cursor.lastIndexOf(":");
    if (separator < 0 || cursor.slice(0, separator) !== this.instanceId) return 0;
    const sequence = Number(cursor.slice(separator + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  }
  private present(agent: Agent): boolean {
    if (agent.registered) return true;
    const elapsed = this.now() - agent.since;
    return agent.state === "working" ? elapsed <= WORKING_LIMIT_MS : agent.waiters.size > 0 || elapsed <= READY_GRACE_MS;
  }
  private live(path: string): Map<string, Agent> {
    const agents = this.paths.get(path) ?? new Map<string, Agent>();
    for (const [key, agent] of agents) if (!this.present(agent)) agents.delete(key);
    if (!agents.size) this.paths.delete(path);
    return agents;
  }
  private snapshot(agent: Agent): TurnAgent {
    const { agentId, label, state, reason, signalId, acceptedAt } = agent;
    return { agentId, ...(label ? { label } : {}), state, ...(reason ? { reason } : {}), ...(signalId ? { signalId } : {}), ...(acceptedAt ? { acceptedAt } : {}) };
  }
  private save(path: string, agent: Agent): void {
    for (const listener of this.listeners) queueMicrotask(listener);
    if (agent.registered) this.options.store?.save({ path, ...this.snapshot(agent) });
    if (agent.signalId && agent.requestedAt) this.options.store?.record({ path, ...this.snapshot(agent), signalId: agent.signalId, requestedAt: agent.requestedAt, via: agent.via, annotations: agent.annotations?.annotations });
  }
  private unavailable(path: string, agent: Agent, error: unknown): void {
    agent.state = "unavailable";
    agent.reason = error instanceof Error ? error.message : String(error);
    this.save(path, agent);
  }
  async register(path: string, agentId: string, label?: string): Promise<TurnAgent> {
    if (!this.options.delivery?.supports(agentId)) throw new Error("This host cannot deliver turns. Use turn wait instead.");
    const agents = this.live(path);
    this.paths.set(path, agents);
    let agent = agents.get(agentId);
    if (!agent) agents.set(agentId, agent = { agentId, state: "ready", sequence: 0, requestedAt: "", since: this.now(), waiters: new Set() });
    agent.registered = true;
    agent.label = label;
    // Repeated registration never resets an uncertain or active delivery.
    this.save(path, agent);
    if (agent.state === "ready") await this.check(path, agent);
    return this.snapshot(agent);
  }
  unregister(path: string, agentId: string): boolean {
    const agent = this.paths.get(path)?.get(agentId);
    if (!agent) return false;
    if (agent.state === "queued" || agent.state === "working") this.unavailable(path, agent, "Registration removed; held delivery or completion monitoring cancelled. No replay attempted.");
    agent.controller?.abort();
    this.paths.get(path)!.delete(agentId);
    this.options.store?.remove(path, agentId);
    for (const finish of [...agent.waiters]) finish();
    return true;
  }
  /** The watcher CLI confirms parsing the response before captured drafts clear. */
  received(path: string, agentId: string, signalId: string): boolean {
    const agent = this.paths.get(path)?.get(agentId);
    const receipt = this.options.store?.receipt(signalId);
    if (receipt?.path === path && receipt.agentId === agentId && receipt.via === "watcher") {
      if (!receipt.acceptedAt) {
        if (receipt.annotations) {
          if (agent?.signalId === signalId && agent.annotations) agent.annotations.accepted(signalId);
          else if (this.options.acknowledgeAnnotations) this.options.acknowledgeAnnotations(agentId, signalId);
          else throw new Error("Annotation acceptance could not be confirmed.");
        }
        receipt.acceptedAt = new Date(this.now()).toISOString();
        this.options.store!.record({ ...receipt, signalId });
      }
      if (agent?.signalId === signalId) agent.acceptedAt = receipt.acceptedAt as string;
      return true;
    }
    if (!agent || agent.signalId !== signalId || agent.via !== "watcher") return false;
    if (!agent.acceptedAt) agent.annotations?.accepted(signalId);
    agent.acceptedAt ??= new Date(this.now()).toISOString();
    this.save(path, agent);
    return true;
  }
  private async check(path: string, agent: Agent): Promise<void> {
    agent.checkedAt = this.now();
    const sequence = agent.sequence;
    try { await this.options.delivery!.inspect(agent.agentId, this.lifetime.signal); }
    catch (error) {
      if (!this.lifetime.signal.aborted && this.paths.get(path)?.get(agent.agentId) === agent && agent.sequence === sequence && agent.state === "ready") this.unavailable(path, agent, error);
    }
  }
  agents(path: string): TurnAgent[] {
    const agents = [...this.live(path).values()];
    for (const agent of agents) if (agent.registered && agent.state === "ready" && this.now() - (agent.checkedAt ?? -Infinity) >= 30_000) void this.check(path, agent);
    return agents.map(agent => this.snapshot(agent)).sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
  waiting(): boolean {
    for (const path of [...this.paths.keys()]) if (this.live(path).size) return true;
    return false;
  }
  request(path: string, agentId: string): TurnPress | "unavailable" | "working" {
    const agent = this.live(path).get(agentId);
    if (!agent || agent.state === "unavailable" || this.lifetime.signal.aborted) return "unavailable";
    if (agent.state !== "ready") return "working";
    agent.sequence++;
    agent.signalId = crypto.randomUUID();
    agent.requestedAt = new Date(this.now()).toISOString();
    agent.since = this.now();
    agent.reason = undefined;
    agent.acceptedAt = undefined;
    agent.annotations = undefined;
    agent.via = agent.waiters.size || !this.options.delivery?.supports(agentId) ? "watcher" : "host";
    agent.state = agent.via === "host" ? "queued" : "working";
    this.save(path, agent);
    try {
      const escaped = path.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      agent.annotations = this.options.capture?.(agentId, agent.signalId, agent.via === "host" ? `<tether-turn path="${escaped}" />` : "");
      this.save(path, agent);
      if (agent.via === "watcher") {
        agent.annotations?.dispatch(agent.signalId);
        for (const wake of [...agent.waiters]) wake();
      } else {
        agent.controller = new AbortController();
        const previous = this.hostTails.get(agentId) ?? Promise.resolve();
        const delivery = previous.then(() => this.deliver(path, agent));
        this.hostTails.set(agentId, delivery);
        void delivery.finally(() => { if (this.hostTails.get(agentId) === delivery) this.hostTails.delete(agentId); });
      }
    } catch (error) { this.unavailable(path, agent, error); }
    return { signalId: agent.signalId, cursor: this.cursor(agent.sequence), sequence: agent.sequence, agentId, state: agent.state, ...(agent.reason ? { reason: agent.reason } : {}) };
  }
  private async deliver(path: string, agent: Agent): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, agent.controller!.signal]);
    const host = this.options.delivery!;
    try {
      signal.throwIfAborted();
      while (await host.inspect(agent.agentId, signal) === "running") await host.wait(agent.agentId, signal);
      const escaped = path.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const event = `<tether-turn path="${escaped}" />`;
      signal.throwIfAborted();
      agent.annotations?.dispatch(agent.signalId!, host.messageOptions(agent.signalId!));
      await host.send(agent.agentId, agent.annotations?.text ?? event, agent.signalId!, signal);
      signal.throwIfAborted();
      agent.acceptedAt = new Date(this.now()).toISOString();
      agent.state = "working";
      this.save(path, agent);
      agent.annotations?.accepted(agent.signalId!);
      await host.wait(agent.agentId, signal);
      if (await host.inspect(agent.agentId, signal) !== "idle") throw new Error("Host wait ended without an idle agent; completion is unknown.");
      signal.throwIfAborted();
      agent.state = "ready";
      agent.checkedAt = this.now();
      this.save(path, agent);
    } catch (error) {
      if (!this.lifetime.signal.aborted && this.paths.get(path)?.get(agent.agentId) === agent) this.unavailable(path, agent,
        signal.aborted ? "Delivery monitoring stopped; completion may be unknown. No replay attempted." : error);
    }
  }
  async wait(path: string, agentId: string, label: string | undefined, after: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<TurnWait> {
    if (this.stopped) return { turn: null, stopped: true };
    const agents = this.live(path);
    this.paths.set(path, agents);
    let agent = agents.get(agentId);
    if (!agent) agents.set(agentId, agent = { agentId, sequence: this.sequenceOf(after), requestedAt: "", state: "ready", since: this.now(), waiters: new Set() });
    agent.label = label;
    const since = after === undefined ? agent.sequence : this.sequenceOf(after);
    const current = agent;
    const result = (): TurnWait => {
      if (this.stopped && current.sequence <= since) return { turn: null, stopped: true };
      if (current.sequence > since && current.via === "watcher" && current.state !== "unavailable") {
        return { turn: { signalId: current.signalId!, cursor: this.cursor(current.sequence), sequence: current.sequence, requestedAt: current.requestedAt, path, agentId }, ...(current.annotations?.annotations ? { annotations: current.annotations.annotations } : {}) };
      }
      return { turn: null, cursor: this.cursor(Math.max(since, current.sequence)) };
    };
    if (agent.sequence > since) return result();
    if (agent.state !== "unavailable" && (agent.via !== "host" || agent.state === "ready")) {
      agent.state = "ready";
      agent.since = this.now();
      this.save(path, agent);
    }
    if (timeoutMs > 0 && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = () => { clearTimeout(timer); current.waiters.delete(finish); signal?.removeEventListener("abort", finish); resolve(); };
        current.waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    if (current.state === "ready") current.since = this.now();
    return result();
  }
  close(deliberate = false): void {
    if (deliberate) this.stopped = true;
    for (const [path, agents] of this.paths) for (const agent of agents.values()) {
      if (agent.via === "host" && (agent.state === "queued" || agent.state === "working")) this.unavailable(path, agent, "Tether stopped; held press dropped or completion unknown. No replay attempted.");
    }
    this.lifetime.abort();
    for (const agents of this.paths.values()) for (const agent of agents.values()) for (const finish of [...agent.waiters]) finish();
  }
}
