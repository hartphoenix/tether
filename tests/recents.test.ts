import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecentsRegistry } from "../src/recents/index";

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
