import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import type { RecentEntry, RecentsRegistry } from "./registry";

export type RecentFile = RecentEntry & { name: string; directory: string };

export type RecentsSnapshot = {
  sequence: number;
  files: RecentFile[];
};

export type SyncRecentsResult = {
  entries: RecentEntry[];
  hostSynchronized: boolean;
};

export type RecordRecentResult = SyncRecentsResult & { entry: RecentEntry };
export type RecordRecentsResult = SyncRecentsResult & { added: RecentEntry[] };
export type RecentsSubscriber = (snapshot: RecentsSnapshot) => void;

async function synchronizeHost(host: HostAdapter, entries: RecentEntry[], target?: HostTarget): Promise<boolean> {
  if (typeof host.recentsChanged !== "function") return false;
  return (await host.recentsChanged(entries, target)) !== false;
}

/**
 * The daemon-owned Recents boundary. Storage reads, writes, snapshot ordering,
 * publication, and host launcher synchronization share one failure-safe queue.
 */
export class RecentsService {
  private tail = Promise.resolve();
  private sequence = 0;
  private readonly subscribers = new Set<RecentsSubscriber>();

  constructor(
    private readonly registry: RecentsRegistry,
    private readonly host: HostAdapter,
  ) {}

  private async queued<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await operation(); }
    finally { release(); }
  }

  private async snapshotNow(): Promise<RecentsSnapshot> {
    const files = await this.registry.files();
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("The Recents snapshot sequence is exhausted.");
    return { sequence: ++this.sequence, files };
  }

  private publish(snapshot: RecentsSnapshot): void {
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(snapshot); } catch { /* a dead view must not fail the mutation */ }
    }
  }

  private async synchronize(snapshot: RecentsSnapshot, target?: HostTarget): Promise<SyncRecentsResult> {
    const entries = snapshot.files.map(({ path, createdAt }) => ({ path, createdAt }));
    const hostSynchronized = await synchronizeHost(this.host, entries, target);
    return { entries, hostSynchronized };
  }

  snapshot(): Promise<RecentsSnapshot> {
    return this.queued(() => this.snapshotNow());
  }

  files(): Promise<RecentFile[]> {
    return this.queued(() => this.registry.files());
  }

  paths(): Promise<string[]> {
    return this.queued(() => this.registry.paths());
  }

  record(path: string, target?: HostTarget): Promise<RecordRecentResult> {
    return this.queued(async () => {
      const entry = await this.registry.add(path);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      return { ...await this.synchronize(snapshot, target), entry };
    });
  }

  recordMany(paths: string[], target?: HostTarget): Promise<RecordRecentsResult> {
    return this.queued(async () => {
      const added = await this.registry.addMany(paths);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      return { ...await this.synchronize(snapshot, target), added };
    });
  }

  remove(path: string, target?: HostTarget): Promise<SyncRecentsResult> {
    return this.queued(async () => {
      await this.registry.remove(path);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      return this.synchronize(snapshot, target);
    });
  }

  subscribe(subscriber: RecentsSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }
}

/** Compatibility helpers for callers that operate without the daemon service. */
export function recordRecent(
  registry: RecentsRegistry,
  host: HostAdapter,
  path: string,
  target?: HostTarget,
): Promise<RecordRecentResult> {
  return new RecentsService(registry, host).record(path, target);
}

export function recordRecents(
  registry: RecentsRegistry,
  host: HostAdapter,
  paths: string[],
  target?: HostTarget,
): Promise<RecordRecentsResult> {
  return new RecentsService(registry, host).recordMany(paths, target);
}

export function removeRecent(
  registry: RecentsRegistry,
  host: HostAdapter,
  path: string,
  target?: HostTarget,
): Promise<SyncRecentsResult> {
  return new RecentsService(registry, host).remove(path, target);
}
