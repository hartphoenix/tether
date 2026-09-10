import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readSafe } from "../documents/safe-files";
import { basename, dirname, extname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { markdownTitle } from "../core/markdown-title";

export type RecentEntry = {
  /** Canonical real path when the entry is returned by list(). */
  path: string;
  /** Unix milliseconds when this path was most recently opened. */
  createdAt: number;
};

export type FolioView = "active" | "archive";
export type FolioSort = "opened" | "modified" | "activity" | "added" | "created" | "name";
export type FolioRetention = { mode: "days"; days: number } | { mode: "forever" } | { mode: "immediate" };

export type FolioEntry = RecentEntry & {
  id: string;
  name: string;
  directory: string;
  repository: string | null;
  view: FolioView;
  pinned: boolean;
  missing: boolean;
  needsAttention: boolean;
  attentionCount: number;
  addedAt: number;
  openedAt: number;
  modifiedAt: number | null;
  activityAt: number | null;
  fileCreatedAt: number | null;
  archivedAt: number | null;
  expiresAt: number | null;
};

export type RecentsRegistryOptions = {
  path: string;
  now?: () => number;
  /** Shared private-store connection. Omit only for legacy JSON compatibility. */
  database?: Database;
  /** Removes conversation and recovery rows before an expired Folio record is removed. */
  deletePrivateData?: (path: string) => void | Promise<void>;
};

export type ListRecentsOptions = {
  /** Include entries whose files no longer exist. Defaults to false. */
  includeStale?: boolean;
};

export type ListFolioOptions = {
  view?: FolioView | "all";
  sort?: FolioSort;
  needsAttention?: boolean;
  missing?: boolean;
  query?: string;
  directory?: string;
  repository?: string;
};

export type FolioMutationResult = { deleted: string[] };

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

function parseRetention(value: unknown): FolioRetention {
  if (!isRecord(value) || typeof value.mode !== "string") return { mode: "forever" };
  if (value.mode === "forever" || value.mode === "immediate") return { mode: value.mode };
  if (value.mode === "days" && Number.isSafeInteger(value.days) && (value.days as number) > 0) return { mode: "days", days: value.days as number };
  return { mode: "forever" };
}

function validateRetention(value: FolioRetention): FolioRetention {
  if (value?.mode === "forever" || value?.mode === "immediate") return { mode: value.mode };
  if (value?.mode === "days" && Number.isSafeInteger(value.days) && value.days > 0) return { mode: "days", days: value.days };
  throw new Error("Archive retention must be a positive number of days, Keep forever, or Delete immediately.");
}

type DocumentRow = {
  id: string;
  path: string;
  title: string | null;
  added_at: number;
  opened_at: number;
  conversation_at: number | null;
  body_mtime_ms: number | null;
  created_at_ms: number | null;
  active: number;
  pinned: number;
  archived_at: number | null;
  expires_at: number | null;
};

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function normalizedPath(path: string): Promise<string> {
  const requested = resolve(path);
  try { return await realpath(requested); }
  catch {
    try { return resolve(await realpath(dirname(requested)), basename(requested)); }
    catch { return requested; }
  }
}

/**
 * Host-neutral Folio storage over the shared private database. The JSON path
 * remains a one-time import source and a compatibility backend for old callers.
 * Folio membership never grants document access.
 */
export class RecentsRegistry {
  readonly path: string;
  private readonly now: () => number;
  private readonly database?: Database;
  private readonly deletePrivateData: (path: string) => void | Promise<void>;
  private importedLegacy = false;
  private importPromise?: Promise<void>;
  private readonly titles = new Map<string, { stamp: string; title: string | null }>();

  constructor(options: RecentsRegistryOptions | string) {
    this.path = typeof options === "string" ? options : options.path;
    this.now = typeof options === "string" ? Date.now : options.now ?? Date.now;
    this.database = typeof options === "string" ? undefined : options.database;
    this.deletePrivateData = typeof options === "string" ? () => {} : options.deletePrivateData ?? (() => {});
    if (this.database) {
      // Old implicit defaults scheduled deletion without an explicit choice.
      // Cancel those deadlines before the service can run its expiry sweep.
      const row = this.database.query("SELECT value FROM settings WHERE key=?").get("archive_retention") as { value: string } | null;
      let retention: FolioRetention = { mode: "forever" };
      try { if (row) retention = parseRetention(JSON.parse(row.value)); } catch {}
      if (retention.mode === "forever") {
        this.database.query("UPDATE documents SET expires_at=NULL WHERE active=0 AND expires_at IS NOT NULL").run();
      }
    }
  }

  private async importLegacy(): Promise<void> {
    if (!this.database || this.importedLegacy) return;
    if (!this.importPromise) this.importPromise = (async () => {
      const imported = this.database!.query("SELECT value FROM settings WHERE key = ?").get("folio_recents_imported") as { value: string } | null;
      if (!imported) {
        const entries = await this.readStored(true);
        const importedEntries = await Promise.all(entries.map(async (entry) => ({ ...entry, path: await normalizedPath(entry.path) })));
        const insert = this.database!.query(`INSERT INTO documents
          (id,path,title,added_at,opened_at,conversation_at,body_mtime_ms,created_at_ms,active,pinned,archived_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,1,0,NULL,NULL) ON CONFLICT(path) DO NOTHING`);
        this.database!.transaction(() => {
          for (const entry of importedEntries) insert.run(crypto.randomUUID(), entry.path, basename(entry.path), entry.createdAt, entry.createdAt, null, null, null);
          this.database!.query("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").run("folio_recents_imported", "1");
        })();
      }
      this.importedLegacy = true;
    })();
    try { await this.importPromise; }
    finally { this.importPromise = undefined; }
  }

  private async readStored(strict = false): Promise<RecentEntry[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.path, "utf8")); }
    catch (cause) {
      if (!strict) return [];
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        try { await lstat(this.path); }
        catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === "ENOENT") return []; }
      }
      throw Object.assign(new Error("The legacy Recents file could not be imported. Repair it and retry; it has not been marked imported.", { cause }), { code: "legacy_recents_import_failed" });
    }
    const entries = Array.isArray(parsed) ? parsed.map(parseEntry) : null;
    if (strict && (!entries || entries.some((entry) => entry === null))) {
      throw Object.assign(new Error("The legacy Recents file contains invalid entries. Repair it and retry; it has not been marked imported."), { code: "legacy_recents_import_failed" });
    }
    return entries?.filter((entry): entry is RecentEntry => entry !== null) ?? [];
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
    if (this.database) {
      const entries = await this.listFolio({ view: "active", sort: "opened" });
      return entries.filter((entry) => options.includeStale || !entry.missing).map((entry) => ({ path: entry.path, createdAt: entry.openedAt }));
    }
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
    if (this.database) {
      const entries = await this.listFolio({ view: "active", sort: "opened" });
      return entries.filter((entry) => options.includeStale || !entry.missing).map((entry) => ({ path: entry.path, createdAt: entry.openedAt, name: entry.name, directory: entry.directory }));
    }
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
      if (this.database) {
        await this.importLegacy();
        const upsert = this.database.query(`INSERT INTO documents
          (id,path,title,added_at,opened_at,conversation_at,body_mtime_ms,created_at_ms,active,pinned,archived_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,1,0,NULL,NULL)
          ON CONFLICT(path) DO UPDATE SET title=excluded.title,opened_at=excluded.opened_at,
            body_mtime_ms=excluded.body_mtime_ms,created_at_ms=COALESCE(documents.created_at_ms,excluded.created_at_ms),active=1,archived_at=NULL,expires_at=NULL`);
        const metadata = await Promise.all(additions.map(async (entry) => ({ entry, info: await stat(entry.path) })));
        this.database.transaction(() => {
          for (const { entry, info } of metadata) upsert.run(crypto.randomUUID(), entry.path, basename(entry.path), entry.createdAt, entry.createdAt, null, info.mtimeMs, info.birthtimeMs > 0 ? info.birthtimeMs : null);
        })();
        return additions;
      }
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
    if (this.database) {
      await this.archive([requestedPath]);
      return;
    }
    await this.mutate(() => this.removeStored(requestedPath));
  }

  private async removeStored(requestedPath: string): Promise<void> {
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
  }

  async clear(): Promise<void> {
    if (this.database) {
      const paths = (await this.listFolio({ view: "active" })).map((entry) => entry.path);
      await this.archive(paths);
      return;
    }
    await this.mutate(async () => { await this.writeStored([]); });
  }

  async listFolio(options: ListFolioOptions = {}): Promise<FolioEntry[]> {
    if (!this.database) {
      const files = await this.files({ includeStale: true });
      return Promise.all(files.map(async (file) => ({
        ...file, id: file.path, repository: null, view: "active" as const, pinned: false,
        missing: !(await fileExists(file.path)), needsAttention: false, attentionCount: 0, addedAt: file.createdAt,
        openedAt: file.createdAt, modifiedAt: null, activityAt: null, fileCreatedAt: null,
        archivedAt: null, expiresAt: null,
      })));
    }
    await this.importLegacy();
    const rows = this.database.query("SELECT * FROM documents").all() as DocumentRow[];
    const knownPaths = new Set(rows.map(row => row.path));
    for (const path of this.titles.keys()) if (!knownPaths.has(path)) this.titles.delete(path);
    const result: FolioEntry[] = [];
    for (const row of rows) {
      const view: FolioView = row.active ? "active" : "archive";
      if (options.view && options.view !== "all" && options.view !== view) continue;
      let missing = true;
      let modifiedAt = row.body_mtime_ms;
      let fileCreatedAt = row.created_at_ms;
      let stamp = "";
      try {
        const info = await stat(row.path);
        missing = !info.isFile();
        if (!missing) {
          modifiedAt = info.mtimeMs;
          fileCreatedAt = info.birthtimeMs > 0 ? info.birthtimeMs : null;
          stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
        }
      } catch {}
      if (options.missing !== undefined && options.missing !== missing) continue;
      let name = basename(row.path).replace(/\.(md|markdown)$/i, "");
      if (!missing) {
        try {
          let cached = this.titles.get(row.path);
          if (cached?.stamp !== stamp) {
            cached = { stamp, title: markdownTitle(await readSafe(row.path)) };
            this.titles.set(row.path, cached);
          }
          name = cached.title ?? name;
        } catch {}
      }
      const directory = dirname(row.path);
      const query = options.query?.trim().toLocaleLowerCase();
      if (query && !`${name}\n${row.path}`.toLocaleLowerCase().includes(query)) continue;
      if (options.directory && directory !== options.directory) continue;
      const repository = await repositoryFor(directory);
      if (options.repository && repository !== options.repository) continue;
      const attentionCount = this.attentionCount(row.id);
      const needsAttention = attentionCount > 0;
      if (options.needsAttention !== undefined && options.needsAttention !== needsAttention) continue;
      result.push({
        id: row.id, path: row.path, createdAt: row.opened_at, name, directory, repository,
        view, pinned: Boolean(row.pinned), missing, needsAttention, attentionCount, addedAt: row.added_at,
        openedAt: row.opened_at, modifiedAt, activityAt: row.conversation_at,
        fileCreatedAt, archivedAt: row.archived_at, expiresAt: row.expires_at,
      });
    }
    return sortFolio(result, options.sort ?? "opened");
  }

  private attentionCount(documentId: string): number {
    if (!this.database) return 0;
    try {
      const row = this.database.query(`SELECT COUNT(*) AS value FROM annotation_events e
        WHERE e.document_id=? AND e.type='comment'
        AND NOT EXISTS (SELECT 1 FROM annotation_events d WHERE d.document_id=e.document_id
          AND d.type='delete' AND d.target_id=e.id)
        AND COALESCE((SELECT s.type FROM annotation_events s WHERE s.document_id=e.document_id
          AND s.thread_id=e.id AND s.type IN ('resolve','reopen') ORDER BY s.seq DESC LIMIT 1),'reopen')='reopen'`).get(documentId) as { value: number };
      return row.value;
    } catch { return 0; }
  }

  async archive(paths: string[]): Promise<FolioMutationResult> {
    return this.mutate(async () => {
      if (!this.database) { for (const path of paths) await this.removeStored(path); return { deleted: [] }; }
      await this.importLegacy();
      const retention = await this.getRetention();
      if (retention.mode === "immediate") return this.deleteRecords(paths);
      const archivedAt = this.now();
      const expiresAt = retention.mode === "forever" ? null : archivedAt + retention.days * 86_400_000;
      const normalized = await Promise.all(paths.map(normalizedPath));
      const update = this.database.query("UPDATE documents SET active=0,archived_at=?,expires_at=? WHERE path=? AND active=1");
      this.database.transaction(() => { for (const path of normalized) update.run(archivedAt, expiresAt, path); })();
      return { deleted: [] };
    });
  }

  async restore(paths: string[]): Promise<void> {
    await this.mutate(async () => {
      if (!this.database) return;
      await this.importLegacy();
      const openedAt = this.now();
      const normalized = await Promise.all(paths.map(normalizedPath));
      const update = this.database.query("UPDATE documents SET active=1,opened_at=?,archived_at=NULL,expires_at=NULL WHERE path=?");
      this.database.transaction(() => { for (const path of normalized) update.run(openedAt, path); })();
    });
  }

  async setPinned(paths: string[], pinned: boolean): Promise<void> {
    await this.mutate(async () => {
      if (!this.database) return;
      await this.importLegacy();
      const normalized = await Promise.all(paths.map(normalizedPath));
      const update = this.database.query("UPDATE documents SET pinned=? WHERE path=?");
      this.database.transaction(() => { for (const path of normalized) update.run(pinned ? 1 : 0, path); })();
    });
  }

  async clearUnpinned(): Promise<FolioMutationResult> {
    if (!this.database) { await this.clear(); return { deleted: [] }; }
    const paths = (await this.listFolio({ view: "active" })).filter((entry) => !entry.pinned).map((entry) => entry.path);
    return this.archive(paths);
  }

  async locate(oldPath: string, targetPath: string): Promise<FolioEntry> {
    return this.mutate(async () => {
      if (!this.database) throw new Error("Locate file requires the private Folio store.");
      await this.importLegacy();
      const requested = resolve(targetPath);
      if (!isMarkdown(requested)) throw new Error("Only .md and .markdown files can be located.");
      let canonical: string;
      try { canonical = await realpath(requested); if (!(await stat(canonical)).isFile()) throw new Error("not-file"); }
      catch { throw new Error("The replacement Markdown file does not exist."); }
      const existing = this.database.query("SELECT id FROM documents WHERE path=?").get(canonical) as { id: string } | null;
      const source = this.database.query("SELECT id FROM documents WHERE path=?").get(await normalizedPath(oldPath)) as { id: string } | null;
      if (!source) throw new Error("The Folio entry does not exist.");
      if (existing && existing.id !== source.id) throw new Error("The replacement path already has a Folio conversation.");
      const info = await stat(canonical);
      this.database.query("UPDATE documents SET path=?,title=?,body_mtime_ms=?,created_at_ms=? WHERE id=?").run(canonical, basename(canonical), info.mtimeMs, info.birthtimeMs > 0 ? info.birthtimeMs : null, source.id);
      const entry = (await this.listFolio({ view: "all" })).find((item) => item.id === source.id);
      if (!entry) throw new Error("The relocated Folio entry could not be read.");
      return entry;
    });
  }

  async delete(paths: string[]): Promise<FolioMutationResult> {
    return this.mutate(() => this.deleteRecords(paths));
  }

  async deleteConversation(paths: string[]): Promise<void> {
    await this.mutate(async () => {
      if (!this.database) return;
      await this.importLegacy();
      for (const requestedPath of paths) {
        const path = await normalizedPath(requestedPath);
        const found = this.database.query("SELECT path FROM documents WHERE path=?").get(path) as { path: string } | null;
        if (!found) continue;
        await this.deletePrivateData(found.path);
        this.database.query("UPDATE documents SET conversation_at=NULL WHERE path=?").run(found.path);
      }
    });
  }

  private async deleteRecords(paths: string[]): Promise<FolioMutationResult> {
    if (!this.database) {
      for (const path of paths) await this.removeStored(path);
      return { deleted: paths.map((path) => resolve(path)) };
    }
    const deleted: string[] = [];
    for (const requestedPath of paths) {
      const path = await normalizedPath(requestedPath);
      const found = this.database.query("SELECT path FROM documents WHERE path=?").get(path) as { path: string } | null;
      if (!found) continue;
      await this.deletePrivateData(found.path);
      this.database.query("DELETE FROM documents WHERE path=?").run(found.path);
      deleted.push(found.path);
    }
    return { deleted };
  }

  async getRetention(): Promise<FolioRetention> {
    if (!this.database) return { mode: "forever" };
    await this.importLegacy();
    const row = this.database.query("SELECT value FROM settings WHERE key=?").get("archive_retention") as { value: string } | null;
    if (!row) return { mode: "forever" };
    try { return parseRetention(JSON.parse(row.value)); } catch { return { mode: "forever" }; }
  }

  async setRetention(retention: FolioRetention): Promise<FolioMutationResult> {
    return this.mutate(async () => {
      if (!this.database) return { deleted: [] };
      const normalized = validateRetention(retention);
      this.database.query("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").run("archive_retention", JSON.stringify(normalized));
      if (normalized.mode === "immediate") {
        const paths = (this.database.query("SELECT path FROM documents WHERE active=0").all() as Array<{ path: string }>).map(({ path }) => path);
        return this.deleteRecords(paths);
      }
      const update = this.database.query("UPDATE documents SET expires_at=? WHERE path=?");
      const rows = this.database.query("SELECT path,archived_at FROM documents WHERE active=0").all() as Array<{ path: string; archived_at: number }>;
      this.database.transaction(() => {
        for (const row of rows) update.run(normalized.mode === "forever" ? null : row.archived_at + normalized.days * 86_400_000, row.path);
      })();
      return this.expireRecords();
    });
  }

  async expire(): Promise<FolioMutationResult> {
    return this.mutate(() => this.expireRecords());
  }

  private async expireRecords(): Promise<FolioMutationResult> {
    if (!this.database) return { deleted: [] };
    const paths = (this.database.query("SELECT path FROM documents WHERE active=0 AND expires_at IS NOT NULL AND expires_at<=?").all(this.now()) as Array<{ path: string }>).map(({ path }) => path);
    return this.deleteRecords(paths);
  }
}

async function repositoryFor(start: string): Promise<string | null> {
  let directory = start;
  while (true) {
    try { if ((await stat(resolve(directory, ".git"))).isDirectory() || (await stat(resolve(directory, ".git"))).isFile()) return directory; } catch {}
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function sortFolio(entries: FolioEntry[], sort: FolioSort): FolioEntry[] {
  const timestamp = (entry: FolioEntry): number | null => sort === "opened" ? entry.openedAt
    : sort === "modified" ? entry.modifiedAt : sort === "activity" ? entry.activityAt
      : sort === "added" ? entry.addedAt : sort === "created" ? entry.fileCreatedAt : null;
  return entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === "name") return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    const left = timestamp(a); const right = timestamp(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return (right ?? 0) - (left ?? 0) || a.name.localeCompare(b.name);
  });
}

export const RecentDocuments = RecentsRegistry;
export const createRecentsRegistry = (options: RecentsRegistryOptions | string): RecentsRegistry => new RecentsRegistry(options);
export const createRecentRegistry = createRecentsRegistry;
