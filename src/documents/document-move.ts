import { link, lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { PrivateStore } from "../storage/private-store";
import { withPathLock } from "./path-lock";
import { syncDirectory } from "./safe-files";

type Move = { id: string; document_id: string; source: string; target: string; dev: number; ino: number };
function conflict(message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code: "move_conflict", status: 409, details });
}
export class DocumentMoves {
  constructor(private readonly store: PrivateStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_moves (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL UNIQUE, dev INTEGER NOT NULL, ino INTEGER NOT NULL
    )`);
  }
  async target(path: string): Promise<string> {
    if (![".md", ".markdown"].includes(extname(path).toLowerCase())) throw conflict("Destination must be an exact .md or .markdown file path.");
    return join(await realpath(dirname(resolve(path))), basename(path));
  }
  async move(source: string, target: string): Promise<void> {
    const row = this.store.documentForPath(source);
    if (!row) throw conflict("The source has no Tether conversation record.");
    if (this.store.documentForPath(target)) throw conflict("The destination already has a Tether record.");
    const info = await lstat(source);
    const parent = await lstat(dirname(target));
    if (!info.isFile() || await realpath(source) !== source) throw conflict("The source path changed.");
    if (info.dev !== parent.dev) throw conflict("Cross-filesystem moves are unsupported. Export and import a .tether package instead.");
    try { await lstat(target); throw conflict("The destination already exists."); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    const move: Move = { id: crypto.randomUUID(), document_id: row.id, source, target, dev: info.dev, ino: info.ino };
    this.store.db.query("INSERT INTO document_moves(id,document_id,source,target,dev,ino) VALUES (?,?,?,?,?,?)").run(move.id, row.id, source, target, info.dev, info.ino);
    try { await this.finish(move); }
    catch (cause) {
      if (await this.cancelUntouched(move)) throw cause;
      throw Object.assign(new Error("Move interrupted. Restart the daemon to reconcile its recorded state."), { code: "move_recovery_required", status: 409, details: { source, target, reason: cause instanceof Error ? cause.message : String(cause) } });
    }
  }
  async recover(): Promise<void> {
    const moves = this.store.db.query("SELECT * FROM document_moves").all() as Move[];
    for (const move of moves) {
      const paths = [move.source, move.target].sort();
      await withPathLock(paths[0]!, () => withPathLock(paths[1]!, async () => {
        try { await this.finish(move); }
        catch (cause) { if (!await this.cancelUntouched(move)) throw cause; }
      }));
    }
  }
  private async cancelUntouched(move: Move): Promise<boolean> {
    const row = this.store.db.query("SELECT path FROM documents WHERE id=?").get(move.document_id) as { path: string } | null;
    const source = await lstat(move.source).catch(() => null);
    let target;
    try { target = await lstat(move.target); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    if (row?.path !== move.source || source?.dev !== move.dev || source?.ino !== move.ino || target && target.dev === move.dev && target.ino === move.ino) return false;
    this.store.db.query("DELETE FROM document_moves WHERE id=?").run(move.id);
    return true;
  }
  private async finish(move: Move): Promise<void> {
    const info = async (path: string) => lstat(path).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; });
    const same = (value: Awaited<ReturnType<typeof info>>) => value?.isFile() && value.dev === move.dev && value.ino === move.ino;
    let source = await info(move.source);
    let target = await info(move.target);
    if (source && !same(source) || target && !same(target) || !source && !target) throw conflict("Move recovery found changed files; restore the intended paths before restarting.", move);
    if (await realpath(dirname(move.source)) !== dirname(move.source) || await realpath(dirname(move.target)) !== dirname(move.target)) throw conflict("A move parent directory changed.");
    if (!target) { await link(move.source, move.target); await syncDirectory(dirname(move.target)); target = await info(move.target); }
    if (!same(target)) throw conflict("The move destination changed.");
    const targetParent = await lstat(dirname(move.target));
    // Exclusive hard-link creation prevents overwrite; both names may briefly exist.
    this.store.db.transaction(() => {
      const record = this.store.db.query("SELECT path FROM documents WHERE id=?").get(move.document_id) as { path: string } | null;
      if (!record || ![move.source, move.target].includes(record.path)) throw conflict("The conversation changed during move recovery.");
      this.store.db.query("UPDATE documents SET path=? WHERE id=?").run(move.target, move.document_id);
      const views = this.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='reader_views'").get();
      if (views) this.store.db.query("UPDATE reader_views SET path=?,parent_dev=?,parent_ino=? WHERE path=?").run(move.target, targetParent.dev, targetParent.ino, move.source);
    }).immediate();
    source = await info(move.source);
    if (source) {
      if (!same(source)) throw conflict("The move source changed before cleanup.");
      await unlink(move.source);
      await syncDirectory(dirname(move.source));
    }
    this.store.db.query("DELETE FROM document_moves WHERE id=?").run(move.id);
  }
}
