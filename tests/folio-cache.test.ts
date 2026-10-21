import { expect, test } from "bun:test";
import { RecentsService } from "../src/recents/service";
import type { RecentsRegistry, FolioEntry } from "../src/recents/registry";
import type { HostAdapter } from "../src/hosts/host-adapter";

test("many Folios share a snapshot; external changes publish once and mutation refresh replaces cache", async () => {
  let scans = 0;
  let files = [{ id: 'one', name: 'Old' }] as FolioEntry[];
  const registry = {
    listFolio: async () => { scans++; await Bun.sleep(1); return files.map(file => ({ ...file })); },
    getRetention: async () => ({ mode: 'forever' }), getFilters: async () => [],
  } as unknown as RecentsRegistry;
  const service = new RecentsService(registry, {} as HostAdapter);
  const versions: number[] = [];
  service.subscribeFolio(snapshot => versions.push(snapshot.sequence));
  const pages = await Promise.all(Array.from({ length: 10 }, () => service.cachedFolioSnapshot()));
  expect(scans).toBe(1);
  expect(new Set(pages.map(page => page.sequence)).size).toBe(1);
  await service.reconcileFolio();
  expect(versions).toHaveLength(0);
  files = [{ id: 'one', name: 'Changed externally' }] as FolioEntry[];
  await service.reconcileFolio();
  expect(versions).toHaveLength(1);
  expect((await service.cachedFolioSnapshot()).files[0]!.name).toBe('Changed externally');
  await service.reconcileFolio();
  expect(versions).toHaveLength(1);
  files = [];
  await service.refresh();
  expect((await service.cachedFolioSnapshot()).files).toHaveLength(0);
});
