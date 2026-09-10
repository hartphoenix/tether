import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { bodyRevision, deriveAnnotationState, validateAnnotationEvent, type AnnotationAnchor, type AnnotationEvent, type DerivedThread, type PendingAnnotation, type ReviewEvent, type Revision } from "../core/index";
import type { DocumentSnapshot, SerializableAnnotationState } from "../shared/contracts";
import { PrivateStore, PrivateStoreConflictError, type MutationReceipt } from "../storage/index";
import { RealPathMutationQueue } from "./mutation-queue";
import { directoryIdentity, readSafe, syncDirectory, type DirectoryIdentity } from "./safe-files";
import { withPathLock } from "./path-lock";
import { DocumentMoves } from "./document-move";
import { importPackageItems, type PackageImportResult } from "./package-import";
import { INPUT_LIMITS, invalidRequest } from "../shared/control-input";

export type DocumentSession = { sessionId: string; id: string; path: string; realPath: string };
export type DocumentGrant = DocumentSession;
export type DocumentServiceOptions = {
  now?: () => number; queue?: RealPathMutationQueue; readText?: (path: string) => Promise<string>;
  store?: PrivateStore; storePath?: string;
  /** Test seam for an external writer landing after the temporary file is complete. */
  beforeBodyReplace?: (path: string) => void | Promise<void>;
};
export type AnnotationEventInput = { type: AnnotationEvent["type"]; actor: string; body?: string; anchor?: AnnotationAnchor; threadId?: string; targetId?: string; throughSeq?: number; bodyRevision?: string; [key: string]: unknown };
export type SaveBodyInput = { session?: DocumentSession | string; grant?: DocumentGrant | string; body?: string; content?: string; expectedBodyRevision: string };
export type SaveBodyArguments = SaveBodyInput | [DocumentSession | string, string, string];
export type AppendEventInput = {
  session?: DocumentSession | string; grant?: DocumentGrant | string; event?: AnnotationEventInput;
  expectedBodyRevision?: string; expectedConversationRevision?: string; expectedLedgerRevision?: string; expectedThreadSequence?: number;
  operationId?: string; mutationId?: string; cursor?: string; reviewedCursor?: string; consumer?: string;
  /** Stable caller payload used when validation derives transient fields such as an anchor. */
  requestFingerprint?: unknown;
  type?: AnnotationEvent["type"]; actor?: string; body?: string; anchor?: AnnotationAnchor; threadId?: string; targetId?: string; throughSeq?: number; bodyRevision?: string;
  [key: string]: unknown;
};
export type AppendEventArguments = AppendEventInput | [DocumentSession | string, AnnotationEventInput, string?, string?];
export type PendingRead = {
  path: string; documentId: string; bodyRevision: Revision; conversationRevision: Revision; ledgerRevision: Revision; cursor: string;
  annotations: SerializableAnnotationState; pending: PendingAnnotation[]; events: PendingAnnotation[]; maxSequence: number; acknowledgement: unknown; bodyChangedSinceAck: boolean;
};
export type ThreadRead = { path: string; thread: DerivedThread; sequence: number };
export type ThreadsRead = { path: string; threads: DerivedThread[]; nextBeforeSequence: number | null };
export type ExactDocumentRead = { document: DocumentSnapshot; source: string };
export type MutationDocumentSnapshot = DocumentSnapshot & { mutation: MutationReceipt };
export type PortableThread = {
  comment: { actor: string; createdAt: string; anchor: AnnotationAnchor; body: string };
  replies: Array<{ actor: string; createdAt: string; body: string }>;
  status: "open";
};
export type ReviewPackage = { format: "tether-review"; version: 1; documents: Array<{ name: string; body: string; threads: PortableThread[] }> };

export class DocumentAccessError extends Error { constructor(message = "The document session is not authorized for this file.") { super(message); this.name = "DocumentAccessError"; } }
export class DocumentConflictError extends Error { constructor(message = "The document changed before this mutation was applied.", readonly details?: unknown) { super(message); this.name = "DocumentConflictError"; } }
export class DocumentReadOnlyError extends Error { readonly ledgerError?: string; constructor(message = "This Markdown document is read-only.", ledgerError?: string) { super(message); this.name = "DocumentReadOnlyError"; this.ledgerError = ledgerError; } }
export class DocumentNotFoundError extends Error { constructor(message = "The Markdown document does not exist.") { super(message); this.name = "DocumentNotFoundError"; } }

function isMarkdown(path: string): boolean { return [".md", ".markdown"].includes(extname(path).toLowerCase()); }
function inputSession(input: { session?: DocumentSession | string; grant?: DocumentGrant | string }): DocumentSession | string {
  const value = input.session ?? input.grant;
  if (value === undefined) throw new DocumentAccessError();
  return value;
}
function sourceEvent(input: AppendEventInput): AnnotationEventInput {
  const candidate = input.event ?? input;
  if (typeof candidate.type !== "string" || !["comment", "reply", "resolve", "reopen", "edit", "delete", "ack"].includes(candidate.type)) throw invalidRequest("Invalid annotation event type.");
  if (typeof candidate.actor !== "string" || !candidate.actor.trim()) throw invalidRequest("An asserted actor is required.");
  const event = { ...candidate, type: candidate.type as AnnotationEvent["type"], actor: candidate.actor } as AnnotationEventInput;
  if (event.body === undefined && typeof event.text === "string") event.body = event.text;
  for (const key of ["id", "seq", "createdAt", "session", "grant", "event", "expectedBodyRevision", "expectedConversationRevision", "expectedLedgerRevision", "expectedThreadSequence", "expectedRevision", "operationId", "mutationId", "cursor", "reviewedCursor", "consumer", "requestFingerprint"]) delete event[key];
  return event;
}
function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
async function atomicReplace(path: string, source: string, expectedSource: string, readText: (path: string) => Promise<string>, beforeReplace?: (path: string) => void | Promise<void>): Promise<void> {
  const info = await stat(path);
  const temporary = join(dirname(path), `.${basename(path)}.tether-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source, { encoding: "utf8", mode: info.mode & 0o777 });
    await chmod(temporary, info.mode & 0o777);
    const temporaryHandle = await open(temporary, "r");
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    await beforeReplace?.(path);
    let canonical: string;
    let current: string;
    try { [canonical, current] = await Promise.all([realpath(path), readText(path)]); }
    catch { throw new DocumentConflictError("The document changed before this save was applied."); }
    if (canonical !== path || current !== expectedSource) throw new DocumentConflictError("The document changed before this save was applied.");
    await rename(temporary, path);
    await syncDirectory(dirname(path));
    await chmod(path, info.mode & 0o777).catch(() => {});
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export class DocumentService {
  private readonly now: () => number;
  private readonly readText: (path: string) => Promise<string>;
  private readonly beforeBodyReplace?: (path: string) => void | Promise<void>;
  readonly queue: RealPathMutationQueue;
  readonly store: PrivateStore;
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly grantedPaths = new Set<string>();
  private readonly parents = new Map<string, DirectoryIdentity>();
  private readonly moves: DocumentMoves;
  private recovery?: Promise<void>;

  constructor(options: DocumentServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.readText = options.readText ?? ((path) => readSafe(path, this.parents.get(path)));
    this.beforeBodyReplace = options.beforeBodyReplace;
    this.queue = options.queue ?? new RealPathMutationQueue();
    this.store = options.store ?? new PrivateStore(options.storePath);
    this.moves = new DocumentMoves(this.store);
  }
  recoverMoves(): Promise<void> { return this.recovery ??= this.moves.recover(); }
  async open(requestedPath: string): Promise<DocumentSession> {
    await this.recoverMoves();
    if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new DocumentNotFoundError("A Markdown path is required.");
    const candidate = resolve(requestedPath);
    if (!isMarkdown(candidate)) throw new DocumentNotFoundError("Only .md and .markdown files can be opened.");
    let canonical: string;
    try { const info = await stat(candidate); if (!info.isFile()) throw new Error(); canonical = await realpath(candidate); } catch { throw new DocumentNotFoundError(); }
    return this.queue.run(canonical, async () => {
      const parent = await directoryIdentity(canonical);
      const previous = this.parents.get(canonical);
      if (previous && (previous.dev !== parent.dev || previous.ino !== parent.ino)) this.revokePath(canonical);
      this.parents.set(canonical, parent);
      this.store.ensureDocument(canonical, this.now());
      const sessionId = crypto.randomUUID();
      const session = { sessionId, id: sessionId, path: canonical, realPath: canonical };
      this.sessions.set(sessionId, session); this.grantedPaths.add(canonical);
      return session;
    });
  }
  grant(path: string): Promise<DocumentSession> { return this.open(path); }
  close(session: DocumentSession | string): void {
    const id = typeof session === "string" ? session : session.sessionId;
    const current = this.sessions.get(id); if (!current) return;
    this.sessions.delete(id);
    if (![...this.sessions.values()].some((entry) => entry.realPath === current.realPath)) this.grantedPaths.delete(current.realPath);
  }
  private async canonicalFor(session: DocumentSession | string): Promise<string> {
    if (typeof session !== "string") {
      const current = this.sessions.get(session.sessionId ?? session.id);
      const requested = session.realPath ?? session.path;
      if (!current || current.realPath !== requested || current.path !== session.path) throw new DocumentAccessError();
      return current.realPath;
    }
    let canonical: string; try { canonical = await realpath(resolve(session)); } catch { throw new DocumentAccessError(); }
    if (!this.grantedPaths.has(canonical)) throw new DocumentAccessError();
    return canonical;
  }
  private assertAuthorized(session: DocumentSession | string, path: string): void {
    if (typeof session === "string") {
      if (!this.grantedPaths.has(path)) throw new DocumentAccessError();
      return;
    }
    const current = this.sessions.get(session.sessionId ?? session.id);
    if (!current || current.realPath !== path || current.path !== path) throw new DocumentAccessError();
  }
  private revokePath(path: string): void {
    for (const [id, session] of this.sessions) if (session.realPath === path) this.sessions.delete(id);
    this.grantedPaths.delete(path);
  }
  private async readSource(session: DocumentSession | string): Promise<{ path: string; source: string }> {
    const path = await this.canonicalFor(session);
    let source: string;
    try { source = await this.readText(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentNotFoundError(); throw cause; }
    this.assertAuthorized(session, path);
    if (!this.store.documentForPath(path)) throw new DocumentAccessError("The private document record was deleted.");
    return { path, source };
  }
  private annotationState(path: string, revision: string): SerializableAnnotationState {
    const state = deriveAnnotationState(this.store.ledger(path, revision));
    return { header: state.header, events: state.events, threads: state.threads, acknowledgements: this.store.acknowledgements(path), maxSequence: state.maxSequence, unresolvedCount: state.unresolvedCount };
  }
  private snapshot(path: string, source: string): DocumentSnapshot {
    if (!this.store.documentForPath(path)) throw new DocumentAccessError("The private document record was deleted.");
    const revision = bodyRevision(source);
    return { path, body: source, content: source, bodyRevision: revision, revision, ledgerRevision: this.store.conversationRevision(path) as Revision, annotations: this.annotationState(path, revision) };
  }
  async read(session: DocumentSession | string): Promise<DocumentSnapshot> { return (await this.readExactSnapshot(session)).document; }
  async readExactSnapshot(session: DocumentSession | string): Promise<ExactDocumentRead> { const value = await this.readSource(session); return { document: this.snapshot(value.path, value.source), source: value.source }; }
  async exportExact(session: DocumentSession | string): Promise<string> { return (await this.readSource(session)).source; }
  exactExport(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }
  export(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }

  async saveBody(input: SaveBodyInput): Promise<DocumentSnapshot>;
  async saveBody(session: DocumentSession | string, body: string, expectedBodyRevision: string): Promise<DocumentSnapshot>;
  async saveBody(inputOrSession: SaveBodyInput | DocumentSession | string, bodyArgument?: string, expectedArgument?: string): Promise<DocumentSnapshot> {
    const input: SaveBodyInput = typeof inputOrSession === "object" && inputOrSession !== null && ("session" in inputOrSession || "grant" in inputOrSession)
      ? inputOrSession : { session: inputOrSession as DocumentSession | string, body: bodyArgument, expectedBodyRevision: expectedArgument ?? "" };
    const nextBody = input.body ?? input.content;
    if (typeof nextBody !== "string") throw new Error("A body and expected body revision are required.");
    if (Buffer.byteLength(nextBody) > INPUT_LIMITS.markdown) throw invalidRequest("Markdown exceeds its byte limit.");
    const path = await this.canonicalFor(inputSession(input));
    return this.queue.run(path, () => withPathLock(path, async () => {
      this.assertAuthorized(inputSession(input), path);
      const current = await this.readText(path);
      if (bodyRevision(current) !== input.expectedBodyRevision) throw new DocumentConflictError("The document body changed before this save was applied.", { currentBodyRevision: bodyRevision(current) });
      await atomicReplace(path, nextBody, current, this.readText, this.beforeBodyReplace);
      return this.snapshot(path, nextBody);
    }));
  }

  async appendEvent(input: AppendEventInput): Promise<MutationDocumentSnapshot>;
  async appendEvent(session: DocumentSession | string, event: AnnotationEventInput, expectedBodyRevision?: string, expectedLedgerRevision?: string): Promise<MutationDocumentSnapshot>;
  async appendEvent(inputOrSession: AppendEventInput | DocumentSession | string, eventArgument?: AnnotationEventInput, expectedBodyArgument?: string, expectedLedgerArgument?: string): Promise<MutationDocumentSnapshot> {
    const input: AppendEventInput = typeof inputOrSession === "object" && inputOrSession !== null && ("session" in inputOrSession || "grant" in inputOrSession)
      ? inputOrSession : { session: inputOrSession as DocumentSession | string, event: eventArgument, expectedBodyRevision: expectedBodyArgument, expectedLedgerRevision: expectedLedgerArgument };
    const eventInput = sourceEvent(input);
    if (typeof eventInput.body === "string" && Buffer.byteLength(eventInput.body) > INPUT_LIMITS.review) throw invalidRequest("Review text exceeds its byte limit.");
    const operationId = input.operationId ?? input.mutationId ?? crypto.randomUUID();
    const path = await this.canonicalFor(inputSession(input));
    return this.queue.run(path, async () => {
      this.assertAuthorized(inputSession(input), path);
      const source = await this.readText(path);
      const revision = bodyRevision(source);
      const expectedBody = input.expectedBodyRevision ?? (typeof input.expectedRevision === "string" ? input.expectedRevision : undefined);
      const payloadHash = input.requestFingerprint !== undefined ? fingerprint(input.requestFingerprint) : eventInput.type === "ack"
        ? fingerprint({ type: "ack", actor: eventInput.actor, consumer: input.consumer ?? eventInput.actor, cursor: input.cursor ?? input.reviewedCursor })
        : fingerprint({ event: eventInput, expectedBody, expectedConversationRevision: input.expectedConversationRevision ?? input.expectedLedgerRevision, expectedThreadSequence: input.expectedThreadSequence });
      try {
        const replay = this.store.mutationReceipt(path, operationId, payloadHash);
        if (replay) return { ...this.snapshot(path, source), mutation: replay };
      } catch (error) { if (error instanceof PrivateStoreConflictError) throw new DocumentConflictError(error.message); throw error; }
      if (eventInput.type === "comment") {
        if (!expectedBody) throw new DocumentConflictError("A comment requires the body revision returned by its completed save.");
        if (!eventInput.anchor || eventInput.anchor.bodyRevision !== revision) throw new DocumentConflictError("The comment anchor does not match the current body revision.");
      }
      if (expectedBody !== undefined && expectedBody !== revision) throw new DocumentConflictError("The document body changed before this annotation was appended.", { currentBodyRevision: revision });
      if (eventInput.type === "ack") {
        const cursor = input.cursor ?? input.reviewedCursor;
        if (!cursor) throw new DocumentConflictError("An acknowledgement requires the opaque cursor returned by pending.");
        const consumer = input.consumer ?? eventInput.actor;
        try {
          const mutation = this.store.acknowledgeWithReceipt({ path, actor: eventInput.actor, consumer, cursor, operationId, payloadHash, now: this.now() });
          return { ...this.snapshot(path, source), mutation };
        } catch (error) { if (error instanceof PrivateStoreConflictError) throw new DocumentConflictError(error.message); throw error; }
      }
      const event = { ...eventInput, id: `a-${crypto.randomUUID()}`, seq: 0, createdAt: new Date(this.now()).toISOString() } as AnnotationEvent;
      try {
        const mutation = this.store.appendEvent({
          path, event, operationId,
          payloadHash,
          expectedConversationRevision: input.expectedConversationRevision ?? input.expectedLedgerRevision,
          expectedThreadSequence: input.expectedThreadSequence, now: this.now(),
        });
        return { ...this.snapshot(path, source), mutation };
      } catch (error) {
        if (error instanceof PrivateStoreConflictError) {
          const document = this.store.documentForPath(path)!;
          const latest = this.store.db.query("SELECT MAX(seq) AS sequence FROM annotation_events WHERE document_id=? AND (id=? OR thread_id=?)").get(document.id, eventInput.threadId ?? "", eventInput.threadId ?? "") as { sequence: number | null };
          throw new DocumentConflictError(error.message, { currentBodyRevision: revision, currentConversationRevision: this.store.conversationRevision(path), currentThreadSequence: latest.sequence });
        }
        throw error;
      }
    });
  }
  appendAnnotation(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.appendEvent(input); }
  private eventAction(input: AppendEventInput, type: AnnotationEvent["type"]): Promise<MutationDocumentSnapshot> { return this.appendEvent({ ...input, type, event: input.event ? { ...input.event, type } : undefined }); }
  appendComment(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "comment"); }
  reply(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "reply"); }
  resolve(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "resolve"); }
  reopen(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "reopen"); }
  edit(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "edit"); }
  delete(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "delete"); }
  acknowledge(input: AppendEventInput): Promise<MutationDocumentSnapshot> { return this.eventAction(input, "ack"); }

  async mutationReceipt(session: DocumentSession | string, operationId: string, requestFingerprint: unknown): Promise<MutationDocumentSnapshot | null> {
    const { path, source } = await this.readSource(session);
    try {
      const mutation = this.store.mutationReceipt(path, operationId, fingerprint(requestFingerprint));
      return mutation ? { ...this.snapshot(path, source), mutation } : null;
    } catch (error) { if (error instanceof PrivateStoreConflictError) throw new DocumentConflictError(error.message); throw error; }
  }

  async pending(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingRead> {
    const { path, source } = await this.readSource(session);
    const revision = bodyRevision(source);
    const document = this.store.ensureDocument(path, this.now());
    const events = this.store.events(path);
    const state = deriveAnnotationState(this.store.ledger(path, revision));
    const acknowledgement = this.store.acknowledgement(path, consumer);
    const watermark = (acknowledgement as { throughSeq?: number } | null)?.throughSeq ?? 0;
    const acknowledgedBodyRevision = (acknowledgement as { bodyRevision?: string } | null)?.bodyRevision;
    const pending = events.filter((event): event is ReviewEvent => event.type !== "ack" && event.seq > watermark && event.actor !== actor).flatMap((event) => {
      const threadId = event.type === "comment" ? event.id : event.threadId;
      const thread = state.byThread.get(threadId);
      return thread ? [{ event, thread }] : [];
    });
    const cursor = this.store.observe(path, consumer, state.maxSequence, revision, this.now()).cursor;
    const conversationRevision = this.store.conversationRevision(path) as Revision;
    return { path, documentId: document.id, bodyRevision: revision, conversationRevision, ledgerRevision: conversationRevision, cursor, annotations: this.annotationState(path, revision), pending, events: pending, maxSequence: state.maxSequence, acknowledgement, bodyChangedSinceAck: acknowledgedBodyRevision !== undefined && acknowledgedBodyRevision !== revision };
  }
  pendingRead(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingRead> { return this.pending(session, actor, consumer); }
  async pendingEvents(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingAnnotation[]> { return (await this.pending(session, actor, consumer)).pending; }
  pendingAnnotations(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingAnnotation[]> { return this.pendingEvents(session, actor, consumer); }

  async thread(session: DocumentSession | string, threadId: string): Promise<ThreadRead> {
    const { path, source } = await this.readSource(session);
    const thread = deriveAnnotationState(this.store.ledger(path, bodyRevision(source))).byThread.get(threadId);
    if (!thread) throw Object.assign(new Error("Annotation thread not found."), { code: "thread_not_found", status: 404 });
    return { path, thread, sequence: thread.latestEvent.seq };
  }
  async threadValue(session: DocumentSession | string, threadId: string): Promise<DerivedThread> { return (await this.thread(session, threadId)).thread; }
  threadRead(session: DocumentSession | string, threadId: string): Promise<ThreadRead> { return this.thread(session, threadId); }
  async threads(session: DocumentSession | string, options: { status?: "open" | "resolved"; beforeSequence?: number; limit?: number } = {}): Promise<ThreadsRead> {
    const { path, source } = await this.readSource(session);
    const before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const matching = deriveAnnotationState(this.store.ledger(path, bodyRevision(source))).threads
      .filter((thread) => !thread.deleted && (!options.status || thread.status === options.status) && thread.latestEvent.seq < before)
      .sort((a, b) => b.latestEvent.seq - a.latestEvent.seq);
    const threads = matching.slice(0, limit);
    return { path, threads, nextBeforeSequence: matching.length > limit ? threads.at(-1)!.latestEvent.seq : null };
  }
  readDocument(session: DocumentSession | string): Promise<DocumentSnapshot> { return this.read(session); }
  readExact(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }
  exportDocument(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }

  async move(sourcePath: string, targetPath: string): Promise<{ path: string; previousPath: string; documentId: string; outcome: "applied" }> {
    await this.recoverMoves();
    const source = await realpath(resolve(sourcePath));
    const target = await this.moves.target(targetPath);
    if (source === target) throw new DocumentConflictError("Source and destination are the same path.");
    const paths = [source, target].sort();
    return this.queue.run(paths[0]!, () => this.queue.run(paths[1]!, () =>
      withPathLock(paths[0]!, () => withPathLock(paths[1]!, async () => {
        await this.readText(source);
        await this.moves.move(source, target);
        const parent = await directoryIdentity(target);
        this.parents.set(target, parent);
        this.parents.delete(source);
        for (const session of this.sessions.values()) if (session.path === source) {
          session.path = target; session.realPath = target;
        }
        if (this.grantedPaths.delete(source)) this.grantedPaths.add(target);
        return { path: target, previousPath: source, documentId: this.store.documentForPath(target)!.id, outcome: "applied" as const };
      }))));
  }

  async locate(path: string, target: string): Promise<DocumentSession> {
    let source = resolve(path); try { source = await realpath(source); } catch {}
    const destination = await realpath(resolve(target));
    this.store.locate(source, destination); return this.open(destination);
  }
  async deleteConversation(path: string): Promise<boolean> {
    let canonical = resolve(path); try { canonical = await realpath(canonical); } catch {}
    return this.queue.run(canonical, async () => {
      this.revokePath(canonical);
      return this.store.deleteConversation(canonical);
    });
  }
  async exportReviews(sessions: Array<DocumentSession | string>): Promise<ReviewPackage> {
    const documents: ReviewPackage["documents"] = [];
    const names = new Set<string>();
    for (const session of sessions) {
      let path: string;
      let source: string;
      if (typeof session === "string") {
        path = await realpath(resolve(session));
        if (!isMarkdown(path)) throw new DocumentNotFoundError("Only .md and .markdown files can be exported.");
        source = await this.readText(path);
        this.store.ensureDocument(path, this.now());
      } else ({ path, source } = await this.readSource(session));
      const threads = deriveAnnotationState(this.store.ledger(path, bodyRevision(source))).threads.filter((thread) => !thread.deleted && thread.status === "open");
      const original = basename(path); const extension = extname(original); const stem = original.slice(0, -extension.length);
      let name = original;
      for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix++) name = `${stem} (${suffix})${extension}`;
      names.add(name.toLocaleLowerCase());
      documents.push({ name, body: source, threads: threads.map((thread) => ({
        comment: { actor: thread.comment.actor, createdAt: thread.comment.createdAt, anchor: thread.comment.anchor, body: thread.comment.body },
        replies: thread.replies.map((reply) => ({ actor: reply.actor, createdAt: reply.createdAt, body: reply.body })), status: "open",
      })) });
    }
    return { format: "tether-review", version: 1, documents };
  }
  async importReviews(value: unknown, directory: string): Promise<string[]> {
    const result = await this.importReviewsResult(value, directory);
    if (result.failed.length) {
      if (result.failed[0]!.code === "destination_record_exists") throw new DocumentConflictError(result.failed[0]!.message, result);
      throw Object.assign(new Error(result.failed[0]!.message), { code: "import_incomplete", details: result });
    }
    return result.paths;
  }
  async importReviewsResult(value: unknown, directory: string): Promise<PackageImportResult> {
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > INPUT_LIMITS.package) throw invalidRequest("Package exceeds its aggregate byte limit.");
    const packageValue = value as ReviewPackage;
    if (!value || typeof value !== "object" || packageValue.format !== "tether-review" || packageValue.version !== 1 || !Array.isArray(packageValue.documents) || packageValue.documents.length > 1_000) throw invalidRequest("Invalid Tether review package.");
    const names = new Set<string>();
    const validated = packageValue.documents.map((item) => {
      const nameKey = typeof item?.name === "string" ? item.name.toLocaleLowerCase() : "";
      if (!item || typeof item.name !== "string" || basename(item.name) !== item.name || !isMarkdown(item.name) || names.has(nameKey) || typeof item.body !== "string" || Buffer.byteLength(item.body) > INPUT_LIMITS.markdown || !Array.isArray(item.threads) || item.threads.length > 10_000) throw invalidRequest("Invalid Tether review package document.");
      names.add(nameKey);
      const events: AnnotationEvent[] = [];
      for (const thread of item.threads) {
        if (!thread || thread.status !== "open" || !thread.comment || !Array.isArray(thread.replies) || thread.replies.length > 10_000) throw invalidRequest("Invalid Tether review package thread.");
        if (typeof thread.comment.body !== "string" || Buffer.byteLength(thread.comment.body) > INPUT_LIMITS.review || typeof thread.comment.actor !== "string" || thread.comment.actor.length > 1_000 || typeof thread.comment.createdAt !== "string" || thread.comment.createdAt.length > 1_000) throw invalidRequest("Invalid Tether review package comment.");
        const id = `a-${crypto.randomUUID()}`;
        events.push(validateAnnotationEvent({
          type: "comment", id, seq: events.length + 1, actor: thread.comment.actor,
          createdAt: thread.comment.createdAt, anchor: thread.comment.anchor, body: thread.comment.body,
        }));
        for (const reply of thread.replies) {
          if (!reply || typeof reply.body !== "string" || Buffer.byteLength(reply.body) > INPUT_LIMITS.review || typeof reply.actor !== "string" || reply.actor.length > 1_000 || typeof reply.createdAt !== "string" || reply.createdAt.length > 1_000) throw invalidRequest("Invalid Tether review package reply.");
          events.push(validateAnnotationEvent({
            type: "reply", id: `a-${crypto.randomUUID()}`, seq: events.length + 1, threadId: id,
            actor: reply.actor, createdAt: reply.createdAt, body: reply.body,
          }));
        }
      }
      return { name: item.name, body: item.body, events };
    });
    return importPackageItems(validated, directory, this.store, this.now);
  }
  async resolveWikilink(currentPath: string, rawTarget: string, format: "wikilink" | "markdown" = "wikilink"): Promise<string> {
    const current = await realpath(resolve(currentPath)); const target = rawTarget.trim();
    const withoutAlias = format === "wikilink" && target.includes("|") ? target.slice(0, target.indexOf("|")) : target;
    const withoutFragment = format === "markdown"
      ? decodeURIComponent(withoutAlias.split(/[?#]/, 1)[0])
      : withoutAlias.split("#", 1)[0];
    if (!withoutFragment) throw new DocumentNotFoundError("A wikilink target is required.");
    const roots = withoutFragment.startsWith("/") ? [withoutFragment] : [resolve(dirname(current), withoutFragment)];
    const candidates = roots.flatMap((candidate) => format === "markdown" || isMarkdown(candidate) ? [candidate] : [candidate, `${candidate}.md`, `${candidate}.markdown`]);
    for (const candidate of candidates) try { if ((await stat(candidate)).isFile()) return await realpath(candidate); } catch {}
    throw new DocumentNotFoundError("Wikilink target does not exist.");
  }
}
export const FileDocumentGateway = DocumentService;
export class DocumentGateway extends DocumentService {}
export class DocumentReviewService extends DocumentService {}
export const createDocumentService = (options?: DocumentServiceOptions): DocumentService => new DocumentService(options);
export const createDocumentGateway = (options?: DocumentServiceOptions): DocumentGateway => new DocumentGateway(options);
