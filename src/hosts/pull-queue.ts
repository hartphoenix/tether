import type { HostTarget } from "./host-adapter";

export type PullOrigin = "user" | "agent";
/** An open request; an agent's announcement carries only the document path. */
export type PullIntentInput = {
  url?: string;
  path?: string;
  kind: "document" | "recents";
  origin: PullOrigin;
  target?: HostTarget;
  sourceUrl?: string;
};
export type PullIntent = PullIntentInput & { seq: number; id: string; expiresAt: number };
export type PullBatch = { cursor: number; folio: number; intents: PullIntent[] };
export type PullStatus = { present: boolean; pending: number; folio: number };

export class PullHostUnavailableError extends Error {
  readonly code = "host_not_connected";
  readonly status = 409;
  constructor(host: string) {
    super(`No ${host} consumer is connected. Open the Tether plugin in ${host}, or choose another host.`);
  }
}

type Waiter = { wake: () => void; finish: () => void };
type Channel = { intents: PullIntent[]; lastWait: number; waiting: number; waiters: Set<Waiter> };

/**
 * Daemon-held open requests for hosts that cannot be driven from outside and
 * instead pull work: the host long-polls, carries out intents, and acks them.
 * An intent lives no longer than its launch ticket.
 */
export class PullQueue {
  private readonly channels = new Map<string, Channel>();
  private seq = 0;
  private folio = 0;

  constructor(private readonly options: { now?: () => number; ttlMs: number; presenceMs?: number }) {}

  private get now(): number { return (this.options.now ?? Date.now)(); }

  private channel(host: string): Channel {
    let channel = this.channels.get(host);
    if (!channel) this.channels.set(host, channel = { intents: [], lastWait: 0, waiting: 0, waiters: new Set() });
    return channel;
  }

  private prune(channel: Channel): void {
    const current = this.now;
    channel.intents = channel.intents.filter(intent => intent.expiresAt > current);
  }

  /** A host is present while a wait is open or one ended within the presence window. */
  present(host: string): boolean {
    const channel = this.channels.get(host);
    if (!channel) return false;
    return channel.waiting > 0 || this.now - channel.lastWait < (this.options.presenceMs ?? 30_000);
  }

  anyPresent(): boolean {
    return [...this.channels.keys()].some(host => this.present(host));
  }

  enqueue(host: string, input: PullIntentInput): PullIntent {
    if (!this.present(host)) throw new PullHostUnavailableError(host);
    const channel = this.channel(host);
    this.prune(channel);
    const intent: PullIntent = { ...input, seq: ++this.seq, id: crypto.randomUUID(), expiresAt: this.now + this.options.ttlMs };
    channel.intents.push(intent);
    for (const waiter of [...channel.waiters]) waiter.wake();
    return intent;
  }

  /** Signal that Folio content changed; waiting hosts refetch it. */
  folioChanged(): void {
    this.folio += 1;
    for (const channel of this.channels.values()) for (const waiter of [...channel.waiters]) waiter.wake();
  }

  private batch(channel: Channel, after: number): PullBatch {
    this.prune(channel);
    return { cursor: this.seq, folio: this.folio, intents: channel.intents.filter(intent => intent.seq > after) };
  }

  /** Resolve at once when intents newer than `after` or a newer Folio version exist; otherwise at the timeout. */
  async wait(host: string, after: number, folio: number, timeoutMs: number, signal?: AbortSignal): Promise<PullBatch> {
    const channel = this.channel(host);
    channel.waiting += 1;
    try {
      const ready = () => this.folio > folio || this.batch(channel, after).intents.length > 0;
      if (!ready() && timeoutMs > 0 && !signal?.aborted) {
        await new Promise<void>(resolve => {
          const waiter: Waiter = { wake: () => { if (ready()) finish(); }, finish: () => finish() };
          const timer = setTimeout(() => finish(), timeoutMs);
          const finish = () => {
            clearTimeout(timer);
            channel.waiters.delete(waiter);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          channel.waiters.add(waiter);
          signal?.addEventListener("abort", finish, { once: true });
        });
      }
      return this.batch(channel, after);
    } finally {
      channel.waiting -= 1;
      channel.lastWait = this.now;
    }
  }

  ack(host: string, ids: string[]): number {
    const channel = this.channels.get(host);
    if (!channel) return 0;
    const before = channel.intents.length;
    const acknowledged = new Set(ids);
    channel.intents = channel.intents.filter(intent => !acknowledged.has(intent.id));
    return before - channel.intents.length;
  }

  status(host: string): PullStatus {
    const channel = this.channels.get(host);
    if (channel) this.prune(channel);
    return { present: this.present(host), pending: channel?.intents.length ?? 0, folio: this.folio };
  }

  /** Release every open wait, e.g. at daemon shutdown. */
  close(): void {
    for (const channel of this.channels.values()) for (const waiter of [...channel.waiters]) waiter.finish();
  }
}
