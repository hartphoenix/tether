import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

export type RecentEntry = {
  /** Canonical real path when the entry is returned by list(). */
  path: string;
  /** Unix milliseconds when this path was most recently opened. */
  createdAt: number;
};

export type RecentsRegistryOptions = {
  path: string;
  now?: () => number;
};

export type ListRecentsOptions = {
  /** Include entries whose files no longer exist. Defaults to false. */
  includeStale?: boolean;
};

type RegistryQueueEntry = { tail: Promise<void>; release: () => void };
const registryQueues = new Map<string, RegistryQueueEntry>();

function isMarkdown(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): RecentEntry | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  return { path: value.path, createdAt };
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/**
 * A small host-neutral JSON MRU registry. It is a convenience index only:
 * callers still need an explicit DocumentService grant before reading a file.
 */
export class RecentsRegistry {
  readonly path: string;
  private readonly now: () => number;

  constructor(options: RecentsRegistryOptions | string) {
    this.path = typeof options === "string" ? options : options.path;
    this.now = typeof options === "string" ? Date.now : options.now ?? Date.now;
  }

  private async readStored(): Promise<RecentEntry[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.path, "utf8")); }
    catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseEntry).filter((entry): entry is RecentEntry => entry !== null);
  }

  private async writeStored(entries: RecentEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700).catch(() => {});
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = registryQueues.get(this.path)?.tail ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    registryQueues.set(this.path, { tail, release });
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (registryQueues.get(this.path)?.tail === tail) registryQueues.delete(this.path);
    }
  }

  /**
   * Return live Markdown entries in MRU order. Missing or malformed entries
   * are tolerated and ignored; this method never rewrites the registry.
   */
  async list(options: ListRecentsOptions = {}): Promise<RecentEntry[]> {
    const stored = await this.readStored();
    const result: RecentEntry[] = [];
    const seen = new Set<string>();
    for (const entry of stored) {
      const requested = resolve(entry.path);
      let canonical: string | null = null;
      try {
        const info = await stat(requested);
        if (info.isFile() && isMarkdown(requested)) canonical = await realpath(requested);
      } catch {}
      if (!canonical) {
        if (options.includeStale) result.push({ path: requested, createdAt: entry.createdAt });
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push({ path: canonical, createdAt: entry.createdAt });
    }
    return result;
  }

  async paths(options: ListRecentsOptions = {}): Promise<string[]> {
    return (await this.list(options)).map((entry) => entry.path);
  }

  async files(options: ListRecentsOptions = {}): Promise<Array<RecentEntry & { name: string; directory: string }>> {
    const entries = await this.list(options);
    return entries.map((entry) => ({ ...entry, name: basename(entry.path), directory: dirname(entry.path) }));
  }

  /** Canonicalize and move one existing Markdown file to the front. */
  async add(requestedPath: string): Promise<RecentEntry> {
    const [entry] = await this.addMany([requestedPath]);
    if (!entry) throw new Error("A recent Markdown path is required.");
    return entry;
  }

  /** Canonicalize and move existing Markdown files to the front as one write. */
  async addMany(requestedPaths: string[]): Promise<RecentEntry[]> {
    return this.mutate(async () => {
      const additions: RecentEntry[] = [];
      const addedPaths = new Set<string>();
      const createdAt = this.now();
      for (const requestedPath of requestedPaths) {
        const requested = resolve(requestedPath);
        if (!isMarkdown(requested)) throw new Error("Only .md and .markdown files can be added to Recents.");
        let canonical: string;
        try {
          if (!(await stat(requested)).isFile()) throw new Error("not-file");
          canonical = await realpath(requested);
        } catch {
          throw new Error("The recent Markdown file does not exist.");
        }
        if (addedPaths.has(canonical)) continue;
        addedPaths.add(canonical);
        additions.push({ path: canonical, createdAt });
      }
      if (!additions.length) return additions;
      const existing = await this.readStored();
      const entries: RecentEntry[] = [...additions];
      const seen = new Set(additions.map((entry) => entry.path));
      for (const entry of existing) {
        const path = resolve(entry.path);
        let normalized: string | null = null;
        try {
          if (await fileExists(path)) normalized = await realpath(path);
        } catch {}
        // Retain stale values in the on-disk registry for tolerant recovery,
        // but deduplicate canonical live aliases and move the opened file MRU.
        const key = normalized ?? path;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path: normalized ?? path, createdAt: entry.createdAt });
      }
      await this.writeStored(entries);
      return additions;
    });
  }

  /** Daemon-facing name; recording a successful open is idempotent. */
  async record(requestedPath: string): Promise<void> {
    await this.add(requestedPath);
  }

  async remove(requestedPath: string): Promise<void> {
    await this.mutate(async () => {
      const requested = resolve(requestedPath);
      let canonical: string | null = null;
      try { canonical = await realpath(requested); } catch {}
      const existing = await this.readStored();
      const filtered: RecentEntry[] = [];
      for (const entry of existing) {
        const path = resolve(entry.path);
        let entryCanonical: string | null = null;
        try { entryCanonical = await realpath(path); } catch {}
        if (path === requested || (canonical && entryCanonical === canonical)) continue;
        filtered.push(entry);
      }
      await this.writeStored(filtered);
    });
  }

  async clear(): Promise<void> {
    await this.mutate(async () => { await this.writeStored([]); });
  }
}

export const RecentDocuments = RecentsRegistry;
export const createRecentsRegistry = (options: RecentsRegistryOptions | string): RecentsRegistry => new RecentsRegistry(options);
export const createRecentRegistry = createRecentsRegistry;
