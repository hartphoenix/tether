import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import type { HostTarget } from "../hosts/host-adapter";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export type StoredView = {
  id: string;
  kind: "document" | "folio";
  path: string | null;
  verifier: string;
  createdAt: number;
  target?: HostTarget;
  parent?: { dev: number; ino: number };
};
export type ViewDraft = { body: string; baseRevision: string; scroll: number; updatedAt: number };

export function cookieVerifier(cookie: string): string {
  return createHash("sha256").update(cookie).digest("hex");
}
export function verifiesCookie(cookie: string | null, verifier: string): boolean {
  if (!cookie || !/^[a-f0-9]{64}$/.test(verifier)) return false;
  return timingSafeEqual(Buffer.from(cookieVerifier(cookie), "hex"), Buffer.from(verifier, "hex"));
}

/** Persistent browser authorization verifiers, never reusable bearer cookies.
 * File identities/positions are separate from the client's cookie. Neither an
 * ID nor a path from an untrusted page is sufficient to restore a view. */
export class ViewStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS reader_views (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT, verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL, target TEXT
    ); CREATE TABLE IF NOT EXISTS reader_drafts (
      view_id TEXT PRIMARY KEY REFERENCES reader_views(id) ON DELETE CASCADE,
      body TEXT NOT NULL, base_revision TEXT NOT NULL, scroll REAL NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS reader_positions (
      view_id TEXT PRIMARY KEY REFERENCES reader_views(id) ON DELETE CASCADE, scroll REAL NOT NULL
    ); CREATE TABLE IF NOT EXISTS reader_zoom (
      view_id TEXT PRIMARY KEY REFERENCES reader_views(id) ON DELETE CASCADE, zoom REAL NOT NULL
    );`);
    const columns = db.query("PRAGMA table_info(reader_views)").all() as { name: string }[];
    if (!columns.some(column => column.name === "parent_dev")) db.exec("ALTER TABLE reader_views ADD COLUMN parent_dev INTEGER; ALTER TABLE reader_views ADD COLUMN parent_ino INTEGER;");
  }
  put(view: StoredView): void {
    let parent = view.parent;
    if (!parent && view.path) { const info = statSync(dirname(view.path)); parent = { dev: info.dev, ino: info.ino }; }
    const target = view.target ? Object.fromEntries(Object.entries(view.target).filter(([key]) =>
      ["host", "windowId", "workspaceId", "tabId", "blockId", "surfaceId", "socketPath", "version", "build", "commit"].includes(key))) : undefined;
    this.db.query(`INSERT INTO reader_views (id,kind,path,verifier,created_at,target,parent_dev,parent_ino) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET verifier=excluded.verifier, path=excluded.path, target=excluded.target,parent_dev=excluded.parent_dev,parent_ino=excluded.parent_ino`)
      .run(view.id, view.kind, view.path, view.verifier, view.createdAt, target ? JSON.stringify(target) : null, parent?.dev ?? null, parent?.ino ?? null);
  }
  list(): StoredView[] {
    return (this.db.query("SELECT * FROM reader_views").all() as Array<Record<string, unknown>>).map(row => ({
      id: row.id as string, kind: row.kind as StoredView["kind"], path: row.path as string | null,
      verifier: row.verifier as string, createdAt: row.created_at as number,
      ...(row.target ? { target: JSON.parse(row.target as string) as HostTarget } : {}),
      ...(typeof row.parent_dev === "number" && typeof row.parent_ino === "number" ? { parent: { dev: row.parent_dev, ino: row.parent_ino } } : {}),
    }));
  }
  saveDraft(id: string, draft: ViewDraft): void {
    this.db.query("INSERT OR REPLACE INTO reader_drafts VALUES (?,?,?,?,?)")
      .run(id, draft.body, draft.baseRevision, draft.scroll, draft.updatedAt);
  }
  draft(id: string): ViewDraft | null {
    const row = this.db.query("SELECT * FROM reader_drafts WHERE view_id=?").get(id) as Record<string, unknown> | null;
    return row ? { body: row.body as string, baseRevision: row.base_revision as string, scroll: row.scroll as number, updatedAt: row.updated_at as number } : null;
  }
  clearDraft(id: string): void { this.db.query("DELETE FROM reader_drafts WHERE view_id=?").run(id); }
  clearDraftsForPath(path: string): void { this.db.query("DELETE FROM reader_drafts WHERE view_id IN (SELECT id FROM reader_views WHERE path=?)").run(path); }
  position(id: string): number { return (this.db.query("SELECT scroll FROM reader_positions WHERE view_id=?").get(id) as { scroll: number } | null)?.scroll ?? 0; }
  zoom(id: string, defaultZoom = 100): number {
    this.db.query("INSERT OR IGNORE INTO reader_zoom (view_id,zoom) VALUES (?,?)").run(id, defaultZoom);
    return (this.db.query("SELECT zoom FROM reader_zoom WHERE view_id=?").get(id) as { zoom: number }).zoom;
  }
  savePosition(id: string, scroll: number, zoom?: number): void {
    this.db.transaction(() => {
      this.db.query("INSERT OR REPLACE INTO reader_positions VALUES (?,?)").run(id, scroll);
      if (zoom !== undefined) this.db.query("INSERT OR REPLACE INTO reader_zoom VALUES (?,?)").run(id, zoom);
    })();
  }
  forget(id: string): void {
    this.db.transaction(() => {
      for (const table of ["reader_drafts", "reader_positions", "reader_zoom"]) this.db.query(`DELETE FROM ${table} WHERE view_id=?`).run(id);
      this.db.query("DELETE FROM reader_views WHERE id=?").run(id);
    })();
  }
  forgetPath(path: string): void {
    this.db.query("DELETE FROM reader_drafts WHERE view_id IN (SELECT id FROM reader_views WHERE path=?)").run(path);
    this.db.query("DELETE FROM reader_views WHERE path=?").run(path);
  }
}
