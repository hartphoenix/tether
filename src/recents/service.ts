import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import type { RecentEntry, RecentsRegistry } from "./registry";

export type RecordRecentResult = {
  entry: RecentEntry;
  entries: RecentEntry[];
  hostSynchronized: boolean;
};

/** Record one recent document and synchronously update the active host. */
export async function recordRecent(
  registry: RecentsRegistry,
  host: HostAdapter,
  path: string,
  target?: HostTarget,
): Promise<RecordRecentResult> {
  const entry = await registry.add(path);
  const entries = await registry.list();
  const hostSynchronized = typeof host.recentsChanged === "function";
  if (hostSynchronized) await host.recentsChanged!(entries, target);
  return { entry, entries, hostSynchronized };
}
