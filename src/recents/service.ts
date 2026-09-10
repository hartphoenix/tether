import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import type { FolioEntry, FolioMutationResult, FolioRetention, ListFolioOptions, RecentEntry, RecentsRegistry } from "./registry";

export type RecentFile = RecentEntry & { name: string; directory: string };

export type RecentsSnapshot = {
  sequence: number;
  files: RecentFile[];
};

export type FolioSnapshot = {
  sequence: number;
  files: FolioEntry[];
  retention: FolioRetention;
};

export type SyncRecentsResult = {
  entries: RecentEntry[];
  hostSynchronized: boolean;
  hostSyncStatus: "unsupported" | "skipped" | "succeeded" | "failed";
  hostSequence?: number;
  hostIssue?: { code: string; message: string };
};

export type RecordRecentResult = SyncRecentsResult & { entry: RecentEntry };
export type RecordRecentsResult = SyncRecentsResult & { added: RecentEntry[] };
export type RecentsSubscriber = (snapshot: RecentsSnapshot) => void;
export type FolioSubscriber = (snapshot: FolioSnapshot) => void;

async function synchronizeHost(host: HostAdapter, entries: RecentEntry[], target?: HostTarget): Promise<boolean> {
  if (typeof host.recentsChanged !== "function") return false;
  return (await host.recentsChanged(entries, target)) !== false;
}

/**
 * The daemon-owned Recents boundary. Storage reads, writes, snapshot ordering,
 * and publication share one queue. Host work uses a separate ordered queue,
 * so a slow launcher never blocks durable mutations or snapshot reads.
 */
export class RecentsService {
  private tail = Promise.resolve();
  private hostTail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private readonly subscribers = new Set<RecentsSubscriber>();
  private readonly folioSubscribers = new Set<FolioSubscriber>();

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

  private async publishFolio(sequence: number): Promise<void> {
    if (!this.folioSubscribers.size) return;
    const snapshot = await this.folioSnapshotAt(sequence);
    for (const subscriber of [...this.folioSubscribers]) {
      try { subscriber(snapshot); } catch { /* a dead view must not fail the mutation */ }
    }
  }

  private async folioSnapshotAt(sequence: number, options: ListFolioOptions = {}): Promise<FolioSnapshot> {
    const [files, retention] = await Promise.all([
      this.registry.listFolio({ ...options, view: options.view ?? "all" }),
      this.registry.getRetention(),
    ]);
    return { sequence, files, retention };
  }

  private async synchronize(snapshot: RecentsSnapshot, target?: HostTarget): Promise<SyncRecentsResult> {
    const entries = snapshot.files.map(({ path, createdAt }) => ({ path, createdAt }));
    try {
      const hostSynchronized = await synchronizeHost(this.host, entries, target);
      return { entries, hostSynchronized, hostSyncStatus: hostSynchronized ? "succeeded" : "unsupported", hostSequence: snapshot.sequence };
    } catch (cause) {
      const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code : "host_sync_failed";
      return { entries, hostSynchronized: false, hostSyncStatus: "failed", hostSequence: snapshot.sequence, hostIssue: { code, message: cause instanceof Error ? cause.message : String(cause) } };
    }
  }

  snapshot(): Promise<RecentsSnapshot> {
    return this.queued(() => this.snapshotNow());
  }

  folioSnapshot(options: ListFolioOptions = {}): Promise<FolioSnapshot> {
    return this.queued(async () => {
      if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("The Folio snapshot sequence is exhausted.");
      return this.folioSnapshotAt(++this.sequence, options);
    });
  }

  /** Publish fresh attention/activity metadata after a conversation mutation. */
  refresh(options: ListFolioOptions = {}): Promise<FolioSnapshot> {
    return this.queued(async () => {
      if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("The Folio snapshot sequence is exhausted.");
      const snapshot = await this.folioSnapshotAt(++this.sequence, options);
      for (const subscriber of [...this.folioSubscribers]) {
        try { subscriber(snapshot); } catch { /* a dead view must not fail refresh */ }
      }
      return snapshot;
    });
  }

  files(): Promise<RecentFile[]> {
    return this.queued(() => this.registry.files());
  }

  paths(): Promise<string[]> {
    return this.queued(() => this.registry.paths());
  }

  private async mutateAndSync<T extends object>(operation: () => Promise<T>, target?: HostTarget): Promise<T & SyncRecentsResult> {
    const pending = await this.queued(async () => {
      const result = await operation();
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      await this.publishFolio(snapshot.sequence);
      // Enqueue before releasing the storage queue to retain snapshot order.
      const sync = this.enqueueHost(snapshot, target);
      return { result, sync };
    });
    return { ...pending.result, ...await pending.sync };
  }

  private enqueueHost(snapshot: RecentsSnapshot, target?: HostTarget): Promise<SyncRecentsResult> {
    const sync = this.hostTail.catch(() => {}).then(() => this.synchronize(snapshot, target));
    this.hostTail = sync;
    return sync;
  }

  /** Retry only host synchronization, using the current registry snapshot. */
  async retryHostSync(target?: HostTarget): Promise<SyncRecentsResult> {
    const pending = await this.queued(async () => ({ sync: this.enqueueHost(await this.snapshotNow(), target) }));
    return pending.sync;
  }

  record(path: string, target?: HostTarget): Promise<RecordRecentResult> {
    return this.mutateAndSync(async () => ({ entry: await this.registry.add(path) }), target);
  }

  recordMany(paths: string[], target?: HostTarget): Promise<RecordRecentsResult> {
    return this.mutateAndSync(async () => ({ added: await this.registry.addMany(paths) }), target);
  }

  remove(path: string, target?: HostTarget): Promise<SyncRecentsResult> {
    return this.mutateAndSync(async () => { await this.registry.remove(path); return {}; }, target);
  }

  archive(paths: string[], target?: HostTarget): Promise<FolioMutationResult & SyncRecentsResult> {
    return this.mutateAndSync(() => this.registry.archive(paths), target);
  }

  restore(paths: string[], target?: HostTarget): Promise<SyncRecentsResult> {
    return this.mutateAndSync(async () => { await this.registry.restore(paths); return {}; }, target);
  }

  setPinned(paths: string[], pinned: boolean): Promise<void> {
    return this.queued(async () => {
      await this.registry.setPinned(paths, pinned);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      await this.publishFolio(snapshot.sequence);
    });
  }

  clearUnpinned(target?: HostTarget): Promise<FolioMutationResult & SyncRecentsResult> {
    return this.mutateAndSync(() => this.registry.clearUnpinned(), target);
  }

  locate(path: string, target: string): Promise<FolioEntry> {
    return this.queued(async () => {
      const entry = await this.registry.locate(path, target);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      await this.publishFolio(snapshot.sequence);
      return entry;
    });
  }

  delete(paths: string[], target?: HostTarget): Promise<FolioMutationResult & SyncRecentsResult> {
    return this.mutateAndSync(() => this.registry.delete(paths), target);
  }

  deleteConversation(paths: string[]): Promise<void> {
    return this.queued(async () => {
      await this.registry.deleteConversation(paths);
      const snapshot = await this.snapshotNow();
      this.publish(snapshot);
      await this.publishFolio(snapshot.sequence);
    });
  }

  getRetention(): Promise<FolioRetention> {
    return this.queued(() => this.registry.getRetention());
  }

  setRetention(retention: FolioRetention, target?: HostTarget): Promise<FolioMutationResult & SyncRecentsResult> {
    return this.mutateAndSync(() => this.registry.setRetention(retention), target);
  }

  expire(target?: HostTarget): Promise<FolioMutationResult & SyncRecentsResult> {
    return this.queued(async () => {
      const result = await this.registry.expire();
      if (result.deleted.length) {
        const snapshot = await this.snapshotNow();
        this.publish(snapshot);
        await this.publishFolio(snapshot.sequence);
        return { ...result, entries: snapshot.files.map(({ path, createdAt }) => ({ path, createdAt })), hostSynchronized: false, hostSyncStatus: "skipped" };
      }
      return { ...result, entries: await this.registry.list(), hostSynchronized: false, hostSyncStatus: "skipped" };
    });
  }

  subscribe(subscriber: RecentsSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  subscribeFolio(subscriber: FolioSubscriber): () => void {
    this.folioSubscribers.add(subscriber);
    return () => { this.folioSubscribers.delete(subscriber); };
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
