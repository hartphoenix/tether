import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { bodyRevision, deriveAnnotationState, validateAnnotationEvent, type AnnotationAnchor, type AnnotationEvent, type DerivedThread, type PendingAnnotation, type ReviewEvent, type Revision } from "../core/index";
import type { DocumentSnapshot, SerializableAnnotationState } from "../shared/contracts";
import { PrivateStore, PrivateStoreConflictError, type MutationReceipt, type DocumentReference } from "../storage/index";
import { RealPathMutationQueue } from "./mutation-queue";
import { readSafe } from "./safe-files";
import { withPathLock } from "./path-lock";
import { DocumentMoves } from "./document-move";
import { importPackageItems, type PackageImportResult } from "./package-import";
import { AgentReads, type AgentPageOptions } from "./agent-reads";
import { LocalFileAccess, FileAccessError, type FileAccess, type FileLocation } from "./file-access";
import { INPUT_LIMITS, invalidRequest } from "../shared/control-input";

export type DocumentSession = { sessionId: string; id: string; path: string; realPath: string; documentId: string; machineId: string; locationVersion: number };
export type DocumentGrant = DocumentSession;
export type DocumentServiceOptions = {
  now?: () => number; queue?: RealPathMutationQueue; readText?: (path: string) => Promise<string>;
  store?: PrivateStore; storePath?: string; fileAccess?: Map<string, FileAccess>;
  /** Test seam for an external writer landing after the temporary file is complete. */
  beforeBodyReplace?: (path: string) => void | Promise<void>;
};
export type AnnotationEventInput = { type: AnnotationEvent["type"]; actor: string; body?: string; anchor?: AnnotationAnchor; threadId?: string; targetId?: string; throughSeq?: number; bodyRevision?: string; [key: string]: unknown };
export type SaveBodyInput = { expectedLocationVersion?: number; session?: DocumentSession | string; grant?: DocumentGrant | string; body?: string; content?: string; expectedBodyRevision: string };
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

export class DocumentAccessError extends Error { readonly code = "document_unauthorized"; readonly status = 403; constructor(message = "The document session is not authorized for this file.") { super(message); this.name = "DocumentAccessError"; } }
export class DocumentConflictError extends Error { readonly code = "conflict"; readonly status = 409; constructor(message = "The document changed before this mutation was applied.", readonly details?: unknown) { super(message); this.name = "DocumentConflictError"; } }
export class DocumentReadOnlyError extends Error { readonly code = "ledger_invalid"; readonly status = 422; readonly ledgerError?: string; constructor(message = "This Markdown document is read-only.", ledgerError?: string) { super(message); this.name = "DocumentReadOnlyError"; this.ledgerError = ledgerError; } }
export class DocumentNotFoundError extends Error { readonly code = "document_not_found"; readonly status = 404; constructor(message = "The Markdown document does not exist.") { super(message); this.name = "DocumentNotFoundError"; } }

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

export class DocumentService {
  private readonly now: () => number;
  private readonly readText: (path: string) => Promise<string>;
  private readonly adapters = new Map<string, FileAccess>();
  private readonly relocating = new Set<string>();
  readonly queue: RealPathMutationQueue;
  readonly store: PrivateStore;
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly moves: DocumentMoves;
  private recovery?: Promise<void>;

  constructor(options: DocumentServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.readText = options.readText ?? readSafe;

    this.queue = options.queue ?? new RealPathMutationQueue();
    this.store = options.store ?? new PrivateStore(options.storePath);
    this.moves = new DocumentMoves(this.store);
    this.adapters.set(this.store.localMachineId, new LocalFileAccess({ readText: options.readText, beforeBodyReplace: options.beforeBodyReplace }));
    for (const [machineId, adapter] of options.fileAccess ?? []) this.adapters.set(machineId, adapter);
  }
  recoverMoves(): Promise<void> { return this.recovery ??= this.moves.recover(); }
  registerFileAccess(machineId: string, adapter: FileAccess): void { this.adapters.set(machineId, adapter); }
  fileAccess(machineId: string): FileAccess {
    const adapter = this.adapters.get(machineId);
    if (!adapter) throw new FileAccessError("connector_disconnected", "The file machine's connector is disconnected.");
    return adapter;
  }
  async open(requestedPath: string, options: {restoreArchived?: boolean; existingReader?: boolean} = {}): Promise<DocumentSession> {
    return this.openLocation(this.store.localMachineId, requestedPath, options);
  }
  async openLocation(machineId: string, path: string, options: {restoreArchived?: boolean; existingReader?: boolean} = {}): Promise<DocumentSession> {
    if (machineId === this.store.localMachineId) await this.recoverMoves();
    const adapter = this.fileAccess(machineId);
    const inspection = await adapter.inspect(path).catch(error => {
      if (machineId === this.store.localMachineId && (error as FileAccessError).code === "file_missing") throw new DocumentNotFoundError();
      throw error;
    });
    return this.queue.run(`register:${machineId}:${inspection.path}`, async () => {
      const existing = this.store.documentForPath(inspection.path,machineId), documentId = existing?.id ?? crypto.randomUUID();
      if (existing && !existing.active && !options.restoreArchived && !options.existingReader) throw new FileAccessError("restore_required", "This document has been archived. Restore it?", 409, {documentId});
      await adapter.bind({documentId,machineId,path:inspection.path,version:existing?.location_version ?? 1});
      const document = this.store.ensureLocation(machineId,inspection.path,this.now(),documentId);
      this.store.db.query("UPDATE documents SET body_mtime_ms=?,created_at_ms=COALESCE(created_at_ms,?) WHERE id=?")
        .run(inspection.mtimeMs,inspection.createdAtMs,document.id);
      return this.openById(document.id,options);
    });
  }

  async openById(documentId: string, options: {restoreArchived?: boolean; existingReader?: boolean} = {}): Promise<DocumentSession> {
    if (this.relocating.has(documentId)) throw new FileAccessError("location_changing", "The document location is changing; retry after it finishes.", 409);
    const document = this.store.documentById(documentId);
    if (!document) throw new DocumentNotFoundError("The document record no longer exists.");
    if (!document.active) {
      if (!options.restoreArchived && !options.existingReader) throw new FileAccessError("restore_required", "This document has been archived. Restore it?", 409, {documentId});
      if (options.restoreArchived) this.store.db.query("UPDATE documents SET active=1,archived_at=NULL,expires_at=NULL WHERE id=?").run(documentId);
    }
    const sessionId = crypto.randomUUID();
    const session = { sessionId, id: sessionId, path: document.path, realPath: document.path,
      documentId, machineId: document.machine_id, locationVersion: document.location_version };
    this.sessions.set(sessionId, session);
    return session;
  }
  grantById(documentId: string, options: {restoreArchived?: boolean; existingReader?: boolean} = {}): Promise<DocumentSession> { return this.openById(documentId, options); }
  grant(path: string): Promise<DocumentSession> { return this.open(path); }
  close(session: DocumentSession | string): void {
    const id = typeof session === "string" ? session : session.sessionId;
    const current = this.sessions.get(id); if (!current) return;
    this.sessions.delete(id);
  }
  private async authorized(session: DocumentSession | string): Promise<DocumentSession> {
    let current: DocumentSession | undefined;
    if (typeof session === "string") {
      let canonical: string;
      try { canonical = await realpath(resolve(session)); } catch { throw new DocumentAccessError(); }
      current = [...this.sessions.values()].find(entry => entry.machineId === this.store.localMachineId && entry.path === canonical);
    } else {
      current = this.sessions.get(session.sessionId ?? session.id);
      if (!current || current.realPath !== session.realPath || current.path !== session.path || current.documentId !== session.documentId || current.machineId !== session.machineId || current.locationVersion !== session.locationVersion) throw new DocumentAccessError();
    }
    if (!current) throw new DocumentAccessError();
    this.assertAuthorized(current, current.path);
    return current;
  }
  private assertAuthorized(session: DocumentSession | string, path: string): void {
    const current = typeof session === "string" ? [...this.sessions.values()].find(entry => entry.machineId === this.store.localMachineId && entry.path === path) : this.sessions.get(session.sessionId ?? session.id);
    if (!current || current.path !== path) throw new DocumentAccessError();
    if (this.relocating.has(current.documentId)) throw new FileAccessError("location_changing", "The document location is changing; retry after it finishes.", 409);
    const record = this.store.documentById(current.documentId);
    if (!record) throw new DocumentAccessError("The private document record was deleted.");
    if (record.machine_id !== current.machineId || record.path !== current.path || record.location_version !== current.locationVersion) throw new FileAccessError("stale_location", "The document location changed; reopen it.", 409);
  }
  async location(session: DocumentSession | string): Promise<FileLocation> {
    const current = await this.authorized(session);
    return { documentId: current.documentId, machineId: current.machineId, path: current.path, version: current.locationVersion };
  }
  private async readSource(session: DocumentSession | string): Promise<{ path: string; source: string; reference: DocumentReference }> {
    const location = await this.location(session), adapter = this.fileAccess(location.machineId);
    await adapter.bind(location);
    const {source} = await adapter.read(location);
    this.assertAuthorized(session, location.path);
    return {path: location.path, source, reference: {documentId:location.documentId}};
  }
  private annotationState(path: DocumentReference, revision: string): SerializableAnnotationState {
    const state = deriveAnnotationState(this.store.ledger(path, revision));
    return { header: state.header, events: state.events, threads: state.threads, acknowledgements: this.store.acknowledgements(path), maxSequence: state.maxSequence, unresolvedCount: state.unresolvedCount };
  }
  private snapshot(reference: DocumentReference, source: string): DocumentSnapshot {
    const document = this.store.document(reference);
    if (!document) throw new DocumentAccessError("The private document record was deleted.");
    const revision = bodyRevision(source);
    return { documentId:document.id,machineId:document.machine_id,locationVersion:document.location_version,path: document.path, body: source, content: source, bodyRevision: revision, revision, ledgerRevision: this.store.conversationRevision(reference) as Revision, annotations: this.annotationState(reference, revision) };
  }
  async barrier(session: DocumentSession | string): Promise<void> {
    const location = await this.location(session), adapter = this.fileAccess(location.machineId);
    await adapter.bind(location); await adapter.barrier(location); this.assertAuthorized(session, location.path);
  }
  async image(session: DocumentSession | string, source: string) {
    const location = await this.location(session), adapter = this.fileAccess(location.machineId);
    await adapter.bind(location); const image = await adapter.image(location, source); this.assertAuthorized(session, location.path); return image;
  }
  async resolveLink(session: DocumentSession | string, target: string, format: "wikilink" | "markdown" = "wikilink", options: {restoreArchived?: boolean; existingReader?: boolean} = {}): Promise<DocumentSession> {
    const location = await this.location(session), adapter = this.fileAccess(location.machineId);
    await adapter.bind(location); const resolved = await adapter.resolveLink(location, target, format); this.assertAuthorized(session, location.path);
    return this.openLocation(location.machineId, resolved.path, options);
  }
  /** Historical reviews do not imply that a current body or anchor context was read. */
  history(documentId: string, options: AgentPageOptions & {threadId?:string} = {}) {
    const document = this.store.documentById(documentId);
    if (!document) throw new DocumentNotFoundError("The document record no longer exists.");
    const reads = new AgentReads(this.store), reference = {documentId};
    const page = options.threadId ? reads.thread(reference,null,options.threadId,options) : reads.threads(reference,null,options);
    return {...page, machineId:document.machine_id, anchorContext:"unavailable" as const};
  }
  async relink(documentId: string, machineId: string, path: string): Promise<DocumentSession> {
    return this.queue.run(documentId, async () => {
      const record = this.store.documentById(documentId);
      if (!record) throw new DocumentNotFoundError("The document record no longer exists.");
      const target = await this.fileAccess(machineId).inspect(path), collision = this.store.documentForPath(target.path, machineId);
      if (collision && collision.id !== documentId) throw new DocumentConflictError("The destination already has a Tether record.");
      if (record.machine_id === machineId && record.path === target.path) return this.openById(documentId,{existingReader:true});
      const old = {documentId, machineId:record.machine_id, path:record.path, version:record.location_version};
      const adapter = this.fileAccess(record.machine_id);
      this.relocating.add(documentId);
      try {
        // A crash after fencing must leave an unfenced generation at the original
        // location. New admissions wait until this operation has committed or failed.
        const reserved = this.store.reserveLocationVersion(documentId,record.location_version);
        await adapter.fence(old);
        this.store.relinkLocation(documentId,reserved.location_version,machineId,target.path);
      } catch (error) {
        const details = {outcome:"not_applied",locationChanged:false,documentId,reopenRequired:true};
        if (error instanceof PrivateStoreConflictError) throw new DocumentConflictError(error.message,details);
        if (error instanceof FileAccessError) throw new FileAccessError(error.code,error.message,error.status,{...(typeof error.details === "object" ? error.details : {}),...details});
        throw error;
      }
      finally { this.relocating.delete(documentId); }
      return this.openById(documentId,{existingReader:true});
    });
  }
  /** Revision probes skip annotation derivation but retain every access check. */
  async revisions(session: DocumentSession | string) {
    const { path, source, reference } = await this.readSource(session);
    return { path, bodyRevision: bodyRevision(source), ledgerRevision: this.store.conversationRevision(reference) };
  }
  async read(session: DocumentSession | string): Promise<DocumentSnapshot> { return (await this.readExactSnapshot(session)).document; }
  async readExactSnapshot(session: DocumentSession | string): Promise<ExactDocumentRead> { const value = await this.readSource(session); return { document: this.snapshot(value.reference, value.source), source: value.source }; }
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
    const session = await this.authorized(inputSession(input)), location = await this.location(session);
    if (input.expectedLocationVersion !== undefined && input.expectedLocationVersion !== location.version) throw new FileAccessError("stale_location", "The document location changed; reopen it.", 409, {outcome:"not_applied",currentLocationVersion:location.version});
    return this.queue.run(location.documentId, async () => {
      this.assertAuthorized(session, location.path);
      const adapter = this.fileAccess(location.machineId); await adapter.bind(location);
      try {
        const saved = await adapter.save(location, {body: nextBody, expectedBodyRevision: input.expectedBodyRevision});
        this.assertAuthorized(session, location.path);
        return this.snapshot({documentId: location.documentId}, saved.source);
      } catch (error) {
        if ((error as FileAccessError).code === "stale_revision") throw new DocumentConflictError((error as Error).message, (error as FileAccessError).details);
        throw error;
      }
    });
  }

  async appendEvent(input: AppendEventInput): Promise<MutationDocumentSnapshot>;
  async appendEvent(session: DocumentSession | string, event: AnnotationEventInput, expectedBodyRevision?: string, expectedLedgerRevision?: string): Promise<MutationDocumentSnapshot>;
  async appendEvent(inputOrSession: AppendEventInput | DocumentSession | string, eventArgument?: AnnotationEventInput, expectedBodyArgument?: string, expectedLedgerArgument?: string): Promise<MutationDocumentSnapshot> {
    const input: AppendEventInput = typeof inputOrSession === "object" && inputOrSession !== null && ("session" in inputOrSession || "grant" in inputOrSession)
      ? inputOrSession : { session: inputOrSession as DocumentSession | string, event: eventArgument, expectedBodyRevision: expectedBodyArgument, expectedLedgerRevision: expectedLedgerArgument };
    const eventInput = sourceEvent(input);
    if (typeof eventInput.body === "string" && Buffer.byteLength(eventInput.body) > INPUT_LIMITS.review) throw invalidRequest("Review text exceeds its byte limit.");
    const operationId = input.operationId ?? input.mutationId ?? crypto.randomUUID();
    const session = await this.authorized(inputSession(input)), path: DocumentReference = {documentId: session.documentId};
    return this.queue.run(session.documentId, async () => {
      this.assertAuthorized(session, session.path);
      const {source} = await this.readSource(session);
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
          const document = this.store.document(path)!;
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
    const { path, source, reference } = await this.readSource(session);
    try {
      const mutation = this.store.mutationReceipt(reference, operationId, fingerprint(requestFingerprint));
      return mutation ? { ...this.snapshot(reference, source), mutation } : null;
    } catch (error) { if (error instanceof PrivateStoreConflictError) throw new DocumentConflictError(error.message); throw error; }
  }

  async pending(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingRead> {
    const { path, source, reference } = await this.readSource(session);
    const revision = bodyRevision(source);
    const document = this.store.document(reference)!;
    const events = this.store.events(reference);
    const state = deriveAnnotationState(this.store.ledger(reference, revision));
    const acknowledgement = this.store.acknowledgement(reference, consumer);
    const watermark = (acknowledgement as { throughSeq?: number } | null)?.throughSeq ?? 0;
    const acknowledgedBodyRevision = (acknowledgement as { bodyRevision?: string } | null)?.bodyRevision;
    const pending = events.filter((event): event is ReviewEvent => event.type !== "ack" && event.seq > watermark && event.actor !== actor).flatMap((event) => {
      const threadId = event.type === "comment" ? event.id : event.threadId;
      const thread = state.byThread.get(threadId);
      return thread ? [{ event, thread }] : [];
    });
    const cursor = this.store.observe(reference, consumer, state.maxSequence, revision, this.now()).cursor;
    const conversationRevision = this.store.conversationRevision(reference) as Revision;
    return { path, documentId: document.id, bodyRevision: revision, conversationRevision, ledgerRevision: conversationRevision, cursor, annotations: this.annotationState(reference, revision), pending, events: pending, maxSequence: state.maxSequence, acknowledgement, bodyChangedSinceAck: acknowledgedBodyRevision !== undefined && acknowledgedBodyRevision !== revision };
  }
  pendingRead(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingRead> { return this.pending(session, actor, consumer); }
  async pendingEvents(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingAnnotation[]> { return (await this.pending(session, actor, consumer)).pending; }
  pendingAnnotations(session: DocumentSession | string, actor = "assistant", consumer = actor): Promise<PendingAnnotation[]> { return this.pendingEvents(session, actor, consumer); }

  async thread(session: DocumentSession | string, threadId: string): Promise<ThreadRead> {
    const { path, source, reference } = await this.readSource(session);
    const thread = deriveAnnotationState(this.store.ledger(reference, bodyRevision(source))).byThread.get(threadId);
    if (!thread) throw Object.assign(new Error("Annotation thread not found."), { code: "thread_not_found", status: 404 });
    return { path, thread, sequence: thread.latestEvent.seq };
  }
  async threadValue(session: DocumentSession | string, threadId: string): Promise<DerivedThread> { return (await this.thread(session, threadId)).thread; }
  threadRead(session: DocumentSession | string, threadId: string): Promise<ThreadRead> { return this.thread(session, threadId); }
  async threads(session: DocumentSession | string, options: { status?: "open" | "resolved"; beforeSequence?: number; limit?: number } = {}): Promise<ThreadsRead> {
    const { path, source, reference } = await this.readSource(session);
    const before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const matching = deriveAnnotationState(this.store.ledger(reference, bodyRevision(source))).threads
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
    const record = this.store.documentForPath(source);
    if (!record) throw new DocumentNotFoundError("The document record no longer exists.");
    const paths = [source, target].sort();
    return this.queue.run(record.id, () => this.queue.run(paths[0]!, () => this.queue.run(paths[1]!, () =>
      withPathLock(paths[0]!, () => withPathLock(paths[1]!, async () => {
        await this.readText(source);
        await this.moves.move(source, target);
        for (const session of this.sessions.values()) if (session.documentId === record.id) {
          session.path = target; session.realPath = target; session.locationVersion = this.store.documentForPath(target)!.location_version;
        }
        return { path: target, previousPath: source, documentId: this.store.documentForPath(target)!.id, outcome: "applied" as const };
      })))));
  }

  async locate(path: string, target: string): Promise<DocumentSession> {
    let source = resolve(path); if (!this.store.documentForPath(source)) { try { source = await realpath(source); } catch {} }
    const document = this.store.documentForPath(source);
    if (!document) throw new DocumentNotFoundError("The document record no longer exists.");
    return this.relink(document.id, this.store.localMachineId, target);
  }
  async deleteConversation(reference: DocumentReference, onlyWithoutConversation = false): Promise<boolean> {
    if (typeof reference === "string") {
      let path = resolve(reference); if (!this.store.documentForPath(path)) { try { path = await realpath(path); } catch {} }
      reference = path;
    }
    const document = this.store.document(reference);
    if (!document) return false;
    return this.queue.run(document.id, async () => {
      if (onlyWithoutConversation && this.store.db.query("SELECT 1 FROM annotation_events WHERE document_id=? AND type IN ('comment','reply') LIMIT 1").get(document.id)) throw Object.assign(new Error("This entry has conversation history. Archive it to keep the conversation."), {code:"conversation_present",status:409});
      for (const [id, session] of this.sessions) if (session.documentId === document.id) this.sessions.delete(id);
      return this.store.deleteConversation({documentId:document.id});
    });
  }
  async exportReviews(sessions: Array<DocumentSession | string>): Promise<ReviewPackage> {
    const documents: ReviewPackage["documents"] = [];
    const names = new Set<string>();
    for (const session of sessions) {
      let path: string;
      let source: string;
      let reference: DocumentReference;
      if (typeof session === "string") {
        path = await realpath(resolve(session));
        if (!isMarkdown(path)) throw new DocumentNotFoundError("Only .md and .markdown files can be exported.");
        source = await this.readText(path);
        this.store.ensureDocument(path, this.now()); reference = path;
      } else ({ path, source, reference } = await this.readSource(session));
      const threads = deriveAnnotationState(this.store.ledger(reference, bodyRevision(source))).threads.filter((thread) => !thread.deleted && thread.status === "open");
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
