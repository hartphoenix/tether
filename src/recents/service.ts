import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import type { RecentEntry, RecentsRegistry } from "./registry";

export type SyncRecentsResult = {
  entries: RecentEntry[];
  hostSynchronized: boolean;
};

export type RecordRecentResult = SyncRecentsResult & { entry: RecentEntry };
export type RecordRecentsResult = SyncRecentsResult & { added: RecentEntry[] };

async function synchronizeHost(host: HostAdapter, entries: RecentEntry[], target?: HostTarget): Promise<boolean> {
  const hostSynchronized = typeof host.recentsChanged === "function";
  if (hostSynchronized) await host.recentsChanged!(entries, target);
  return hostSynchronized;
}

/** Record one recent document and synchronously update the active host. */
export async function recordRecent(
  registry: RecentsRegistry,
  host: HostAdapter,
  path: string,
  target?: HostTarget,
): Promise<RecordRecentResult> {
  const result = await recordRecents(registry, host, [path], target);
  const entry = result.added[0];
  if (!entry) throw new Error("A recent Markdown path is required.");
  return { ...result, entry };
}

/** Record several recent documents with one registry write and host update. */
export async function recordRecents(
  registry: RecentsRegistry,
  host: HostAdapter,
  paths: string[],
  target?: HostTarget,
): Promise<RecordRecentsResult> {
  const added = await registry.addMany(paths);
  const entries = await registry.list();
  const hostSynchronized = await synchronizeHost(host, entries, target);
  return { added, entries, hostSynchronized };
}

/** Remove one recent document and synchronously update the active host. */
export async function removeRecent(
  registry: RecentsRegistry,
  host: HostAdapter,
  path: string,
  target?: HostTarget,
): Promise<SyncRecentsResult> {
  await registry.remove(path);
  const entries = await registry.list();
  const hostSynchronized = await synchronizeHost(host, entries, target);
  return { entries, hostSynchronized };
}
