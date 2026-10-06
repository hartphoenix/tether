import { bodyRevision, type Revision } from "../core/index";
import { chmod, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { directoryIdentity, readSafe, syncDirectory, type DirectoryIdentity } from "./safe-files";
import { withPathLock } from "./path-lock";
import { RealPathMutationQueue } from "./mutation-queue";
import { INPUT_LIMITS } from "../shared/control-input";
import { readReferencedImage } from "./image-assets";

export type FileLocation = Readonly<{ documentId: string; machineId: string; path: string; version: number }>;
export type FileInspection = { path: string; mtimeMs: number; createdAtMs: number | null; title?: string | null };
export type FileRead = { source: string; bodyRevision: Revision };
export type FileAsset = { bytes: Uint8Array; contentType: string; etag: string };
export interface FileAccess {
  inspect(path: string): Promise<FileInspection>;
  bind(location: FileLocation): Promise<void>;
  read(location: FileLocation): Promise<FileRead>;
  save(location: FileLocation, input: { body: string; expectedBodyRevision: string }): Promise<FileRead>;
  image(location: FileLocation, source: string): Promise<FileAsset>;
  resolveLink(location: FileLocation, target: string, format: "wikilink" | "markdown"): Promise<FileInspection>;
  barrier(location: FileLocation): Promise<void>;
  fence(location: FileLocation): Promise<void>;
}
export class FileAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503, readonly details?: unknown) { super(message); this.name = "FileAccessError"; }
}
type Binding = { location: FileLocation; parent: DirectoryIdentity; fenced: boolean };

/** Filesystem operations only; connectors never need a review database. */
export class LocalFileAccess implements FileAccess {
  private readonly bindings = new Map<string, Binding>();
  private readonly fenced = new Map<string, number>();
  private readonly queue = new RealPathMutationQueue();
  constructor(private readonly options: { readText?: (path: string) => Promise<string>; beforeBodyReplace?: (path: string) => void | Promise<void> } = {}) {}

  async inspect(path: string): Promise<FileInspection> {
    if (typeof path !== "string" || !path.trim() || ![".md", ".markdown"].includes(extname(path).toLowerCase())) throw new FileAccessError("invalid_document_type", "A .md or .markdown path is required.", 400);
    try {
      const canonical = await realpath(resolve(path)), info = await stat(canonical);
      if (!info.isFile()) throw new FileAccessError("not_a_file", "The Markdown path is not a regular file.", 400);
      return { path: canonical, mtimeMs: info.mtimeMs, createdAtMs: info.birthtimeMs > 0 ? info.birthtimeMs : null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileAccessError("file_missing", "The Markdown file does not exist.", 404);
      throw error;
    }
  }
  async bind(location: FileLocation): Promise<void> {
    if ((this.fenced.get(location.documentId) ?? 0) >= location.version) throw new FileAccessError("stale_location", "The document location changed; reopen it.", 409);
    const previous = this.bindings.get(location.documentId);
    if (previous && previous.location.version >= location.version) {
      this.binding(location);
      return;
    }
    const inspected = await this.inspect(location.path);
    if (inspected.path !== location.path) throw new FileAccessError("path_changed", "The document path changed; register its current location.", 409);
    const parent = await directoryIdentity(location.path);
    if ((this.fenced.get(location.documentId) ?? 0) >= location.version) throw new FileAccessError("stale_location", "The document location changed; reopen it.", 409);
    const current = this.bindings.get(location.documentId);
    if (current && current.location.version >= location.version) { this.binding(location); return; }
    this.bindings.set(location.documentId, { location: { ...location }, parent, fenced: false });
  }
  private binding(location: FileLocation): Binding {
    const binding = this.bindings.get(location.documentId);
    if (!binding || binding.fenced || (this.fenced.get(location.documentId) ?? 0) >= location.version || binding.location.machineId !== location.machineId || binding.location.path !== location.path || binding.location.version !== location.version) throw new FileAccessError("stale_location", "The document location changed; reopen it.", 409);
    return binding;
  }
  private async source(location: FileLocation): Promise<string> {
    const binding = this.binding(location);
    try { return await (this.options.readText?.(location.path) ?? readSafe(location.path, binding.parent)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileAccessError("file_missing", "The Markdown file does not exist.", 404);
      throw error;
    }
  }
  async read(location: FileLocation): Promise<FileRead> {
    return this.queue.run(location.path, async () => {
      const source = await this.source(location);
      this.binding(location);
      return { source, bodyRevision: bodyRevision(source) };
    });
  }
  async save(location: FileLocation, input: { body: string; expectedBodyRevision: string }): Promise<FileRead> {
    this.binding(location);
    if (typeof input.body !== "string" || Buffer.byteLength(input.body) > INPUT_LIMITS.markdown) throw new FileAccessError("input_too_large", "Markdown exceeds its byte limit.", 413);
    return this.queue.run(location.path, () => withPathLock(location.path, async () => {
      const current = await this.source(location);
      const revision = bodyRevision(current);
      if (revision !== input.expectedBodyRevision) throw new FileAccessError("stale_revision", "The document body changed before this save was applied.", 409, { outcome: "not_applied", currentBodyRevision: revision });
      const info = await stat(location.path);
      const temporary = join(dirname(location.path), `.${basename(location.path)}.tether-${process.pid}-${crypto.randomUUID()}.tmp`);
      let replaced = false;
      try {
        await writeFile(temporary, input.body, { encoding: "utf8", mode: info.mode & 0o777 });
        await chmod(temporary, info.mode & 0o777);
        const handle = await open(temporary, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        await this.options.beforeBodyReplace?.(location.path);
        if (await this.source(location) !== current) throw new FileAccessError("stale_revision", "The document changed before this save was applied.", 409, { outcome: "not_applied" });
        this.binding(location);
        await rename(temporary, location.path);
        replaced = true;
        await syncDirectory(dirname(location.path));
        return { source: input.body, bodyRevision: bodyRevision(input.body) };
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (replaced) throw new FileAccessError("outcome_unknown", "Save not yet confirmed; read the current file before retrying.", 503);
        throw error;
      }
    }));
  }
  async image(location: FileLocation, source: string): Promise<FileAsset> {
    const body = await this.read(location);
    const asset = await readReferencedImage(location.path, body.source, source);
    this.binding(location);
    return asset;
  }
  async resolveLink(location: FileLocation, rawTarget: string, format: "wikilink" | "markdown"): Promise<FileInspection> {
    this.binding(location);
    const target = rawTarget.trim(), withoutAlias = format === "wikilink" ? target.split("|", 1)[0]! : target;
    let path: string;
    try { path = format === "markdown" ? decodeURIComponent(withoutAlias.split(/[?#]/, 1)[0]!) : withoutAlias.split("#", 1)[0]!; }
    catch { throw new FileAccessError("invalid_request", "Invalid document link.", 400); }
    if (!path || path.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new FileAccessError("invalid_request", "Expected a file link.", 400);
    const candidate = resolve(dirname(location.path), path);
    const candidates = format === "markdown" || [".md", ".markdown"].includes(extname(candidate).toLowerCase()) ? [candidate] : [`${candidate}.md`, `${candidate}.markdown`, candidate];
    for (const value of candidates) {
      try { const inspected = await this.inspect(value); this.binding(location); return inspected; }
      catch (error) { if (!["file_missing", "invalid_document_type"].includes((error as FileAccessError).code)) throw error; }
    }
    throw new FileAccessError("file_missing", "Document link target does not exist.", 404);
  }
  async barrier(location: FileLocation): Promise<void> { await this.queue.run(location.path, () => { this.binding(location); }); }
  async fence(location: FileLocation): Promise<void> {
    this.fenced.set(location.documentId, Math.max(this.fenced.get(location.documentId) ?? 0, location.version));
    const binding = this.bindings.get(location.documentId);
    if (binding && binding.location.version <= location.version) binding.fenced = true;
    await this.queue.run(location.path, () => {});
  }
}
