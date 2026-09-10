import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RecentsRegistry, RecentsService, moveToTrash, pickMarkdownFiles, recordRecent, recordRecents, removeRecent } from "../src/recents/index";
import type { HostAdapter } from "../src/hosts/host-adapter";
import { PrivateStore } from "../src/storage/private-store";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("stores canonical Markdown paths in deduplicated MRU order", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-"));
  directories.push(directory);
  const path = join(directory, "one.md");
  const second = join(directory, "two.markdown");
  const alias = join(directory, "alias.md");
  await writeFile(path, "One\n");
  await writeFile(second, "Two\n");
  await symlink(path, alias);
  const canonicalPath = await realpath(path);
  const canonicalSecond = await realpath(second);
  const registry = new RecentsRegistry({ path: join(directory, "state", "recent-files.json"), now: (() => { let value = 10; return () => value++; })() });
  await registry.add(path);
  await registry.add(second);
  await registry.add(alias);
  expect(await registry.paths()).toEqual([canonicalPath, canonicalSecond]);
  const raw = JSON.parse(await readFile(registry.path, "utf8")) as Array<{ path: string }>;
  expect(raw.map((entry) => entry.path)).toEqual([canonicalPath, canonicalSecond]);
  expect((await stat(registry.path)).mode & 0o077).toBe(0);
});

test("adds multiple Markdown paths atomically in selection order", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-many-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.markdown");
  const invalid = join(directory, "invalid.txt");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  await writeFile(invalid, "Invalid\n");
  const registry = new RecentsRegistry(join(directory, "recent-files.json"));

  const added = await registry.addMany([first, second, first]);
  expect(added.map((entry) => entry.path)).toEqual([await realpath(first), await realpath(second)]);
  expect(await registry.paths()).toEqual([await realpath(first), await realpath(second)]);
  await expect(registry.addMany([second, invalid])).rejects.toThrow("Only .md and .markdown files");
  expect(await registry.paths()).toEqual([await realpath(first), await realpath(second)]);
});

test("tolerates malformed and stale entries without authorizing documents", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-"));
  directories.push(directory);
  const live = join(directory, "live.md");
  await writeFile(live, "Live\n");
  const registryPath = join(directory, "recent-files.json");
  await writeFile(registryPath, JSON.stringify([{ path: live, createdAt: 2 }, { path: join(directory, "gone.md"), createdAt: 1 }, "bad", { nope: true }]));
  const registry = new RecentsRegistry(registryPath);
  const canonicalLive = await realpath(live);
  expect(await registry.paths()).toEqual([canonicalLive]);
  expect((await registry.list({ includeStale: true })).map((entry) => entry.path)).toEqual([canonicalLive, join(directory, "gone.md")]);
  await writeFile(registryPath, "not-json");
  expect(await registry.list()).toEqual([]);
});

test("serializes concurrent adds atomically and creates private state directories", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-"));
  directories.push(directory);
  const paths = await Promise.all(["a.md", "b.md", "c.md"].map(async (name) => { const path = join(directory, name); await writeFile(path, name); return path; }));
  const registry = new RecentsRegistry(join(directory, "private", "recent-files.json"));
  await Promise.all(paths.map((path) => registry.add(path)));
  expect((await registry.paths()).sort()).toEqual((await Promise.all(paths.map((path) => realpath(path)))).sort());
  expect((await stat(join(directory, "private"))).mode & 0o077).toBe(0);
  await chmod(registry.path, 0o644);
  await registry.add(paths[0]);
  expect((await stat(registry.path)).mode & 0o077).toBe(0);
});

test("records a recent document and synchronizes the active host", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-service-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const registry = new RecentsRegistry(join(directory, "recent-files.json"));
  const synchronized: string[][] = [];
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
  };

  const result = await recordRecent(registry, host, path, { host: "wave" });
  expect(result).toMatchObject({ entry: { path: await realpath(path) }, hostSynchronized: true });
  expect(synchronized).toEqual([[await realpath(path)]]);
});

test("records several recent documents with one host synchronization", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-service-many-"));
  directories.push(directory);
  const paths = await Promise.all(["one.md", "two.md"].map(async (name) => {
    const path = join(directory, name);
    await writeFile(path, name);
    return path;
  }));
  const registry = new RecentsRegistry(join(directory, "recent-files.json"));
  const synchronized: string[][] = [];
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
  };

  const result = await recordRecents(registry, host, paths, { host: "wave" });
  const canonicalPaths = await Promise.all(paths.map((path) => realpath(path)));
  expect(result.added.map((entry) => entry.path)).toEqual(canonicalPaths);
  expect(synchronized).toEqual([canonicalPaths]);
});

test("reports host synchronization failures after preserving the registry update", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-service-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const registry = new RecentsRegistry(join(directory, "recent-files.json"));
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async () => { throw new Error("Wave update failed"); },
  };

  expect(await recordRecent(registry, host, path, { host: "wave" })).toMatchObject({
    hostSynchronized: false,
    hostIssue: { code: "host_sync_failed", message: "Wave update failed" },
  });
  expect(await registry.paths()).toEqual([await realpath(path)]);
});

test("removes a recent document and synchronizes the remaining launchers", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-remove-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  const registry = new RecentsRegistry(join(directory, "recent-files.json"));
  await registry.add(first);
  await registry.add(second);
  const synchronized: string[][] = [];
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
  };

  await removeRecent(registry, host, second, { host: "wave" });
  expect(await registry.paths()).toEqual([await realpath(first)]);
  expect(synchronized).toEqual([[await realpath(first)]]);
});

test("publishes ordered snapshots and continues after host synchronization fails", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-coordinator-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  let syncCalls = 0;
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async () => { if (syncCalls++ === 0) throw new Error("Wave update failed"); },
  };
  const service = new RecentsService(new RecentsRegistry(join(directory, "recent-files.json")), host);
  const received: Array<{ sequence: number; paths: string[] }> = [];
  const unsubscribe = service.subscribe((snapshot) => received.push({ sequence: snapshot.sequence, paths: snapshot.files.map((file) => file.path) }));
  service.subscribe(() => { throw new Error("closed view"); });

  const firstResult = await service.record(first, { host: "wave" });
  const secondResult = await service.record(second, { host: "wave" });
  const final = await service.snapshot();

  expect(firstResult).toMatchObject({ hostSynchronized: false, hostIssue: { message: "Wave update failed" } });
  expect(secondResult.hostSynchronized).toBe(true);
  expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]);
  expect(received[0]?.paths).toEqual([await realpath(first)]);
  expect(received[1]?.paths).toEqual([await realpath(second), await realpath(first)]);
  expect(final.sequence).toBe(3);
  expect(final.files.map((file) => file.path)).toEqual([await realpath(second), await realpath(first)]);

  unsubscribe();
  await service.remove(first, { host: "wave" });
  expect(received).toHaveLength(2);
});

test("serializes concurrent service mutations and reports a real host synchronization", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-recents-service-concurrent-"));
  directories.push(directory);
  const paths = await Promise.all(["one.md", "two.md"].map(async (name) => {
    const path = join(directory, name);
    await writeFile(path, name);
    return path;
  }));
  const snapshots: number[] = [];
  const host: HostAdapter = {
    id: "browser",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async () => false,
  };
  const service = new RecentsService(new RecentsRegistry(join(directory, "recent-files.json")), host);
  service.subscribe((snapshot) => { snapshots.push(snapshot.sequence); });

  const results = await Promise.all(paths.map((path) => service.record(path)));
  expect(snapshots).toEqual([1, 2]);
  expect(results.every((result) => result.hostSynchronized === false)).toBe(true);
  expect((await service.paths()).sort()).toEqual((await Promise.all(paths.map((path) => realpath(path)))).sort());
});

test("uses Finder for an authorized macOS trash operation", async () => {
  if (process.platform !== "darwin") return;
  const commands: string[][] = [];
  await moveToTrash("/tmp/review.md", async (command) => { commands.push(command); });
  expect(commands).toHaveLength(1);
  expect(commands[0]?.[0]).toBe("osascript");
  expect(commands[0]?.at(-1)).toBe("/tmp/review.md");
});

test("configures the macOS picker for multiple Markdown files and validates its response", async () => {
  if (process.platform !== "darwin") return;
  const commands: string[][] = [];
  const paths = await pickMarkdownFiles(async (command) => {
    commands.push(command);
    return JSON.stringify(["/tmp/one.md", "/tmp/two.markdown"]);
  });
  expect(paths).toEqual(["/tmp/one.md", "/tmp/two.markdown"]);
  expect(commands[0]?.slice(0, 4)).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e"]);
  expect(commands[0]?.at(-1)).toContain('panel.prompt = "Add Files"');
  expect(commands[0]?.at(-1)).toContain('panel.allowedFileTypes = ["md", "markdown"]');
  await expect(pickMarkdownFiles(async () => "not-json")).rejects.toThrow("invalid response");
  await expect(pickMarkdownFiles(async () => JSON.stringify([""]))).rejects.toThrow("invalid paths");
});

test("keeps active and archived Folio entries in the private store without deleting Markdown", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  let current = 1_000;
  const deleted: string[] = [];
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({
    path: join(directory, "recent-files.json"), database: store.db,
    now: () => current, deletePrivateData: (value) => { deleted.push(value); store.deleteConversation(value); },
  });

  await registry.add(path);
  expect(await registry.getRetention()).toEqual({ mode: "forever" });
  expect((await registry.listFolio({ view: "active" }))[0]).toMatchObject({
    path: await realpath(path), view: "active", pinned: false, missing: false,
    addedAt: 1_000, openedAt: 1_000,
  });

  current = 2_000;
  await registry.archive([path]);
  expect(await registry.paths()).toEqual([]);
  expect((await registry.listFolio({ view: "archive" }))[0]).toMatchObject({
    path: await realpath(path), archivedAt: 2_000, expiresAt: null,
  });
  expect(await readFile(path, "utf8")).toBe("Review\n");

  current = 3_000;
  await registry.restore([path]);
  expect((await registry.listFolio({ view: "active" }))[0]).toMatchObject({ openedAt: 3_000, archivedAt: null, expiresAt: null });
  expect(deleted).toEqual([]);
  store.close();
});

test("old implicit archive deadlines are cancelled, while explicit expiry survives", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-retention-upgrade-"));
  directories.push(directory);
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const path = join(await realpath(directory), "old.md");
  store.ensureDocument(path, 1);
  store.db.query("UPDATE documents SET active=0, archived_at=1, expires_at=2 WHERE path=?").run(path);
  const options = { path: join(directory, "recent-files.json"), database: store.db, now: () => 100 };
  const registry = new RecentsRegistry(options);
  expect(await registry.expire()).toEqual({ deleted: [] });
  expect(store.db.query("SELECT expires_at FROM documents WHERE path=?").get(path)).toEqual({ expires_at: null });
  store.db.query("INSERT INTO settings(key,value) VALUES (?,?)").run("archive_retention", JSON.stringify({ mode: "days", days: 1 }));
  store.db.query("UPDATE documents SET expires_at=2 WHERE path=?").run(path);
  expect((await new RecentsRegistry(options).expire()).deleted).toEqual([path]);
  store.close();
});

test("applies retention changes from the original clearing time and expires only private data", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-retention-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  let current = 100;
  const deleted: string[] = [];
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({
    path: join(directory, "recent-files.json"), database: store.db, now: () => current,
    deletePrivateData: (path) => { deleted.push(path); store.deleteConversation(path); },
  });
  await registry.addMany([first, second]);
  await registry.setPinned([first], true);
  await registry.clearUnpinned();
  expect((await registry.listFolio({ view: "active" })).map((entry) => entry.name)).toEqual(["first"]);
  expect((await registry.listFolio({ view: "archive" })).map((entry) => entry.name)).toEqual(["second"]);

  current = 100 + 2 * 86_400_000;
  const result = await registry.setRetention({ mode: "days", days: 1 });
  expect(result.deleted).toEqual([await realpath(second)]);
  expect(deleted).toEqual([await realpath(second)]);
  expect(await readFile(second, "utf8")).toBe("Second\n");

  await registry.setRetention({ mode: "immediate" });
  await registry.archive([first]);
  expect(await registry.listFolio({ view: "all" })).toEqual([]);
  expect(await readFile(first, "utf8")).toBe("First\n");
  store.close();
});

test("lists missing Folio records and locates them without merging conversations", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-locate-"));
  directories.push(directory);
  const old = join(directory, "old.md");
  const target = join(directory, "target.md");
  const occupied = join(directory, "occupied.md");
  await writeFile(old, "Old\n");
  await writeFile(target, "Target\n");
  await writeFile(occupied, "Occupied\n");
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({ path: join(directory, "recent-files.json"), database: store.db });
  await registry.add(old);
  const canonicalOld = await realpath(old);
  await unlink(old);
  expect((await registry.listFolio({ missing: true }))[0]).toMatchObject({ path: canonicalOld, missing: true });
  const located = await registry.locate(canonicalOld, target);
  expect(located).toMatchObject({ path: await realpath(target), missing: false });
  await registry.add(occupied);
  await expect(registry.locate(target, occupied)).rejects.toThrow("already has a Folio conversation");
  store.close();
});

test("imports the existing JSON recent list once into SQLite", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-import-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  const recentsPath = join(directory, "recent-files.json");
  await writeFile(path, "Review\n");
  await writeFile(recentsPath, JSON.stringify([{ path, createdAt: 42 }]));
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({ path: recentsPath, database: store.db });
  expect(await registry.paths()).toEqual([await realpath(path)]);
  await writeFile(recentsPath, JSON.stringify([]));
  expect(await registry.paths()).toEqual([await realpath(path)]);
  store.close();
});

test("tracks unresolved-thread attention without treating a deleted reply as a deleted thread", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-attention-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const canonical = await realpath(path);
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({ path: join(directory, "recent-files.json"), database: store.db });
  await registry.add(path);
  const id = store.documentForPath(canonical)!.id;
  const insert = store.db.query(`INSERT INTO annotation_events
    (document_id,seq,id,type,actor,created_at,thread_id,target_id,payload_json) VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run(id, 1, "comment", "comment", "hart", new Date().toISOString(), null, null, "{}");
  insert.run(id, 2, "reply", "reply", "assistant", new Date().toISOString(), "comment", null, "{}");
  insert.run(id, 3, "delete-reply", "delete", "assistant", new Date().toISOString(), "comment", "reply", "{}");
  expect((await registry.listFolio())[0]?.needsAttention).toBe(true);
  expect((await registry.listFolio())[0]?.attentionCount).toBe(1);
  insert.run(id, 4, "delete-comment", "delete", "hart", new Date().toISOString(), "comment", "comment", "{}");
  expect((await registry.listFolio())[0]?.needsAttention).toBe(false);
  insert.run(id, 5, "second", "comment", "hart", new Date().toISOString(), null, null, "{}");
  insert.run(id, 6, "third", "comment", "hart", new Date().toISOString(), null, null, "{}");
  insert.run(id, 7, "resolved", "resolve", "hart", new Date().toISOString(), "second", null, "{}");
  expect((await registry.listFolio())[0]?.attentionCount).toBe(1);
  insert.run(id, 8, "reopened", "reopen", "hart", new Date().toISOString(), "second", null, "{}");
  insert.run(id, 9, "reopened-again", "reopen", "hart", new Date().toISOString(), "second", null, "{}");
  expect((await registry.listFolio())[0]?.attentionCount).toBe(2);
  store.close();
});

test("refreshes Folio heading titles when the Markdown changes", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-title-"));
  directories.push(directory);
  const path = join(directory, "filename.md");
  await writeFile(path, "## First heading\n");
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({ path: join(directory, "recent-files.json"), database: store.db });
  await registry.add(path);
  expect((await registry.listFolio())[0]?.name).toBe("First heading");
  await writeFile(path, "## First heading\n# Highest heading\n");
  expect((await registry.listFolio())[0]?.name).toBe("Highest heading");
  expect((await registry.listFolio({ query: "filename.md" })).length).toBe(1);
  store.close();
});

test("deletes a conversation without removing its active Folio entry", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-conversation-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({
    path: join(directory, "recent-files.json"), database: store.db,
    deletePrivateData: (value) => { store.deleteConversation(value); },
  });
  await registry.add(path);
  store.db.query("UPDATE documents SET conversation_at=? WHERE path=?").run(10, await realpath(path));
  await registry.deleteConversation([path]);
  expect((await registry.listFolio())[0]).toMatchObject({ path: await realpath(path), view: "active", activityAt: null });
  store.close();
});

test("does not synchronize host launchers during an unchanged expiry check", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-folio-expiry-"));
  directories.push(directory);
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  let syncCalls = 0;
  const host: HostAdapter = {
    id: "wave", detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {}, openExternal: async () => {}, recentsChanged: async () => { syncCalls++; },
  };
  const service = new RecentsService(new RecentsRegistry({ path: join(directory, "recent-files.json"), database: store.db }), host);
  expect(await service.expire()).toMatchObject({ deleted: [], entries: [], hostSynchronized: false });
  expect(syncCalls).toBe(0);
  store.close();
});

test("slow host synchronization does not block registry mutations or reads and retains snapshot order", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-host-queue-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First");
  await writeFile(second, "Second");
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  const received: string[][] = [];
  const host: HostAdapter = {
    id: "wave", detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {}, openExternal: async () => {},
    recentsChanged: async (entries) => {
      received.push(entries.map(({ path }) => path));
      if (received.length === 1) { started(); await blocked; }
    },
  };
  const service = new RecentsService(new RecentsRegistry(join(directory, "recent-files.json")), host);
  const firstWrite = service.record(first);
  await running;
  const secondWrite = service.record(second);
  try {
    const paths = await service.paths();
    expect(paths).toEqual([await realpath(second), await realpath(first)]);
    expect(received).toHaveLength(1);
  } finally { release(); }
  const results = await Promise.all([firstWrite, secondWrite]);
  expect(results.map(({ hostSequence }) => hostSequence)).toEqual([1, 2]);
  expect(received[1]).toEqual([await realpath(second), await realpath(first)]);
});

test("host retries use current state and distinguish unsupported, skipped, failed and succeeded", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-host-retry-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review");
  const host: HostAdapter = {
    id: "browser", detect: async () => true,
    capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {}, openExternal: async () => {},
  };
  const service = new RecentsService(new RecentsRegistry(join(directory, "recent-files.json")), host);
  expect((await service.record(path)).hostSyncStatus).toBe("unsupported");
  expect((await service.expire()).hostSyncStatus).toBe("skipped");
  host.recentsChanged = async () => { throw new Error("Unavailable"); };
  expect((await service.retryHostSync()).hostSyncStatus).toBe("failed");
  let snapshot: string[] = [];
  host.recentsChanged = async (entries) => { snapshot = entries.map(({ path }) => path); };
  expect((await service.retryHostSync()).hostSyncStatus).toBe("succeeded");
  expect(snapshot).toEqual([await realpath(path)]);
  expect(await service.paths()).toEqual(snapshot);
});

test("failed legacy import remains recoverable after repairing corrupt, invalid, or unreadable input", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-legacy-repair-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  const legacy = join(directory, "recent-files.json");
  await writeFile(path, "Review");
  const store = new PrivateStore(join(directory, "tether.sqlite"));
  const registry = new RecentsRegistry({ path: legacy, database: store.db });
  for (const value of ["not-json", "{}", JSON.stringify([{ path, createdAt: 1 }, "bad"])]) {
    await writeFile(legacy, value);
    await expect(registry.paths()).rejects.toMatchObject({ code: "legacy_recents_import_failed" });
    expect(store.db.query("SELECT value FROM settings WHERE key='folio_recents_imported'").get()).toBeNull();
    expect(store.db.query("SELECT id FROM documents").all()).toHaveLength(0);
  }
  await unlink(legacy);
  await symlink(join(directory, "absent.json"), legacy);
  await expect(registry.paths()).rejects.toMatchObject({ code: "legacy_recents_import_failed" });
  await unlink(legacy);
  await symlink(directory, legacy);
  await expect(registry.paths()).rejects.toMatchObject({ code: "legacy_recents_import_failed" });
  await unlink(legacy);
  await writeFile(legacy, JSON.stringify([{ path, createdAt: 1 }]));
  expect(await registry.paths()).toEqual([await realpath(path)]);
  store.close();
});
