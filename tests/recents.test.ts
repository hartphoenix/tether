import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecentsRegistry, RecentsService, moveToTrash, pickMarkdownFiles, recordRecent, recordRecents, removeRecent } from "../src/recents/index";
import type { HostAdapter } from "../src/hosts/host-adapter";

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

test("surfaces host synchronization failures", async () => {
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

  await expect(recordRecent(registry, host, path, { host: "wave" })).rejects.toThrow("Wave update failed");
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

test("publishes ordered snapshots and recovers its queue after host synchronization fails", async () => {
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

  await expect(service.record(first, { host: "wave" })).rejects.toThrow("Wave update failed");
  const secondResult = await service.record(second, { host: "wave" });
  const final = await service.snapshot();

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
