import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  ANNOTATION_START,
  appendAnnotationEvent,
  appendAnnotationEventToEnvelope,
  bodyRevision,
  createAnnotationLedger,
  deriveAnnotationState,
  ledgerRevision,
  pendingAnnotations,
  rejoinAnnotationLedger,
  serializeAnnotationLedger,
  splitAnnotationLedger,
  validateAnnotationLedger,
  type AnnotationAnchor,
  type AnnotationEvent,
  type AnnotationLedger,
  type DerivedThread,
  type PendingAnnotation,
  type Revision,
} from "../core/index";
import type { DocumentSnapshot, SerializableAnnotationState } from "../shared/contracts";
import { RealPathMutationQueue } from "./mutation-queue";

export type DocumentSession = {
  /** Opaque session identifier suitable for a browser route. */
  sessionId: string;
  /** Alias for integrations that call the identifier `id`. */
  id: string;
  /** Canonical real path granted to this session. */
  path: string;
  /** Alias retained for callers that distinguish requested and real paths. */
  realPath: string;
};

/** Compatibility name used by the daemon's authorization layer. */
export type DocumentGrant = DocumentSession;

export type DocumentServiceOptions = {
  now?: () => number;
  queue?: RealPathMutationQueue;
};

export type AnnotationEventInput = {
  type: AnnotationEvent["type"];
  actor: string;
  body?: string;
  anchor?: AnnotationAnchor;
  threadId?: string;
  targetId?: string;
  throughSeq?: number;
  bodyRevision?: string;
  /** Allows the service to accept structured event-shaped values from HTTP. */
  [key: string]: unknown;
};

export type SaveBodyInput = {
  session?: DocumentSession | string;
  grant?: DocumentGrant | string;
  body?: string;
  content?: string;
  expectedBodyRevision: string;
};

export type SaveBodyArguments = SaveBodyInput | [DocumentSession | string, string, string];

export type AppendEventInput = {
  session?: DocumentSession | string;
  grant?: DocumentGrant | string;
  event?: AnnotationEventInput;
  expectedBodyRevision?: string;
  expectedLedgerRevision?: string;
  /** Event fields may be supplied at the top level for HTTP adapters. */
  type?: AnnotationEvent["type"];
  actor?: string;
  body?: string;
  anchor?: AnnotationAnchor;
  threadId?: string;
  targetId?: string;
  throughSeq?: number;
  bodyRevision?: string;
  [key: string]: unknown;
};

export type AppendEventArguments = AppendEventInput | [DocumentSession | string, AnnotationEventInput, string?, string?];

function inputSession(input: { session?: DocumentSession | string; grant?: DocumentGrant | string }): DocumentSession | string {
  const value = input.session ?? input.grant;
  if (value === undefined) throw new DocumentAccessError();
  return value;
}

export type PendingRead = {
  path: string;
  documentId: string | null;
  bodyRevision: Revision;
  ledgerRevision: Revision;
  annotations: SerializableAnnotationState;
  pending: PendingAnnotation[];
  /** Compatibility alias used by the legacy API. */
  events: PendingAnnotation[];
  maxSequence: number;
  acknowledgement: unknown;
};

export type ThreadRead = {
  path: string;
  thread: DerivedThread;
};

export class DocumentAccessError extends Error {
  constructor(message = "The document session is not authorized for this file.") {
    super(message);
    this.name = "DocumentAccessError";
  }
}

export class DocumentConflictError extends Error {
  constructor(message = "The document changed before this mutation was applied.") {
    super(message);
    this.name = "DocumentConflictError";
  }
}

export class DocumentReadOnlyError extends Error {
  readonly ledgerError?: string;

  constructor(message = "This document has a malformed annotation ledger and is read-only.", ledgerError?: string) {
    super(message);
    this.name = "DocumentReadOnlyError";
    this.ledgerError = ledgerError;
  }
}

export class DocumentNotFoundError extends Error {
  constructor(message = "The Markdown document does not exist.") {
    super(message);
    this.name = "DocumentNotFoundError";
  }
}

function isMarkdown(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializableAnnotationState(ledger: AnnotationLedger | null): SerializableAnnotationState {
  const state = deriveAnnotationState(ledger ?? []);
  return {
    header: state.header,
    events: state.events,
    threads: state.threads,
    acknowledgements: [...state.acknowledgements.values()],
    maxSequence: state.maxSequence,
    unresolvedCount: state.unresolvedCount,
  };
}

function emptyAnnotations(): SerializableAnnotationState {
  return { events: [], threads: [], acknowledgements: [], maxSequence: 0, unresolvedCount: 0 };
}

/** Return the editable body preceding a malformed terminal ledger marker. */
function bodyBeforeMalformedLedger(source: string): string {
  const marker = new RegExp(`^${escapeRegExp(ANNOTATION_START)}(?:\\r?\\n|$)`, "m").exec(source);
  return marker ? source.slice(0, marker.index) : source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function malformedSnapshot(path: string, source: string, error: unknown): DocumentSnapshot {
  const body = bodyBeforeMalformedLedger(source);
  const message = errorMessage(error);
  return {
    path,
    body,
    content: body,
    bodyRevision: bodyRevision(body),
    ledgerRevision: ledgerRevision(null),
    revision: bodyRevision(body),
    annotations: emptyAnnotations(),
    readOnly: true,
    ledgerError: message,
  };
}

function snapshotFromSource(path: string, source: string): DocumentSnapshot {
  const split = splitAnnotationLedger(source);
  if (split.ledger) validateAnnotationLedger(split.ledger);
  const annotations = serializableAnnotationState(split.ledger);
  return {
    path,
    body: split.body,
    content: split.body,
    bodyRevision: bodyRevision(split.body),
    ledgerRevision: ledgerRevision(split.ledgerText),
    revision: bodyRevision(split.body),
    annotations,
  };
}

type ParsedSource = {
  source: string;
  body: string;
  ledger: AnnotationLedger | null;
  ledgerText: string | null;
};

function parseWritableSource(source: string): ParsedSource {
  const split = splitAnnotationLedger(source);
  if (split.ledger) validateAnnotationLedger(split.ledger);
  return { source, body: split.body, ledger: split.ledger, ledgerText: split.ledgerText };
}

function sourceEvent(input: AppendEventInput): AnnotationEventInput {
  const candidate = input.event ?? input;
  const type = candidate.type;
  const actor = candidate.actor;
  if (typeof type !== "string" || !["comment", "reply", "resolve", "reopen", "edit", "delete", "ack"].includes(type)) {
    throw new Error("Invalid annotation event type.");
  }
  if (typeof actor !== "string" || !actor.trim()) throw new Error("An asserted actor is required.");
  const event: AnnotationEventInput = { ...candidate, type: type as AnnotationEvent["type"], actor };
  if (event.body === undefined && typeof event.text === "string") event.body = event.text;
  if (event.throughSeq === undefined && typeof event.through === "number") event.throughSeq = event.through;
  // Client-controlled metadata must never be allowed to choose event identity
  // or sequence. The service allocates those inside the serialized mutation.
  delete event.id;
  delete event.seq;
  delete event.createdAt;
  delete event.session;
  delete event.grant;
  delete event.event;
  delete event.expectedBodyRevision;
  delete event.expectedLedgerRevision;
  delete event.expectedRevision;
  return event;
}

function completeEvent(input: AnnotationEventInput, ledger: AnnotationLedger | null, now: () => number): AnnotationEvent {
  const sequence = (ledger?.events.at(-1)?.seq ?? 0) + 1;
  return {
    ...input,
    id: `a-${crypto.randomUUID()}`,
    seq: sequence,
    createdAt: new Date(now()).toISOString(),
  } as AnnotationEvent;
}

async function atomicReplace(path: string, source: string): Promise<void> {
  const info = await stat(path);
  const temporary = join(dirname(path), `.${basename(path)}.tether-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source, { encoding: "utf8", mode: info.mode & 0o777 });
    // Existing files may have unusual user-only permissions; preserve exactly
    // the permission bits supported by this platform before the rename.
    await chmod(temporary, info.mode & 0o777);
    await rename(temporary, path);
    await chmod(path, info.mode & 0o777).catch(() => {});
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class DocumentService {
  private readonly now: () => number;
  readonly queue: RealPathMutationQueue;
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly grantedPaths = new Set<string>();

  constructor(options: DocumentServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new RealPathMutationQueue();
  }

  /** Resolve, validate, and explicitly grant one canonical Markdown file. */
  async open(requestedPath: string): Promise<DocumentSession> {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new DocumentNotFoundError("A Markdown path is required.");
    const candidate = resolve(requestedPath);
    if (!isMarkdown(candidate)) throw new DocumentNotFoundError("Only .md and .markdown files can be opened.");
    let info;
    let canonical: string;
    try {
      info = await stat(candidate);
      if (!info.isFile()) throw new Error("not-file");
      canonical = await realpath(candidate);
    } catch {
      throw new DocumentNotFoundError();
    }
    const sessionId = crypto.randomUUID();
    const session: DocumentSession = { sessionId, id: sessionId, path: canonical, realPath: canonical };
    this.sessions.set(sessionId, session);
    this.grantedPaths.add(canonical);
    return session;
  }

  grant(requestedPath: string): Promise<DocumentSession> {
    return this.open(requestedPath);
  }

  /** A session is single-document; close only removes that session grant. */
  close(session: DocumentSession | string): void {
    const id = typeof session === "string" ? session : session.sessionId;
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.delete(id);
    if (![...this.sessions.values()].some((entry) => entry.realPath === current.realPath)) this.grantedPaths.delete(current.realPath);
  }

  private async canonicalFor(session: DocumentSession | string): Promise<string> {
    if (typeof session !== "string") {
      const sessionId = typeof session.sessionId === "string" ? session.sessionId : session.id;
      const requestedPath = typeof session.realPath === "string" ? session.realPath : session.path;
      const current = this.sessions.get(sessionId);
      if (!current || typeof requestedPath !== "string" || current.realPath !== requestedPath || current.path !== (session.path ?? requestedPath)) throw new DocumentAccessError();
      return current.realPath;
    }
    const candidate = resolve(session);
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { throw new DocumentAccessError(); }
    if (!this.grantedPaths.has(canonical)) throw new DocumentAccessError();
    return canonical;
  }

  private async readSource(session: DocumentSession | string): Promise<{ path: string; source: string }> {
    const path = await this.canonicalFor(session);
    try { return { path, source: await readFile(path, "utf8") }; }
    catch { throw new DocumentNotFoundError(); }
  }

  async read(session: DocumentSession | string): Promise<DocumentSnapshot> {
    const { path, source } = await this.readSource(session);
    try { return snapshotFromSource(path, source); }
    catch (error) { return malformedSnapshot(path, source, error); }
  }

  /** Read the source bytes exactly, without reconstructing Markdown or ledger data. */
  async exportExact(session: DocumentSession | string): Promise<string> {
    return (await this.readSource(session)).source;
  }

  exactExport(session: DocumentSession | string): Promise<string> {
    return this.exportExact(session);
  }

  export(session: DocumentSession | string): Promise<string> {
    return this.exportExact(session);
  }

  private async mutate<T>(session: DocumentSession | string, operation: (path: string, parsed: ParsedSource) => Promise<T>): Promise<T> {
    const path = await this.canonicalFor(session);
    return this.queue.run(path, async () => {
      let source: string;
      try { source = await readFile(path, "utf8"); } catch { throw new DocumentNotFoundError(); }
      let parsed: ParsedSource;
      try { parsed = parseWritableSource(source); }
      catch (error) { throw new DocumentReadOnlyError(undefined, errorMessage(error)); }
      return operation(path, parsed);
    });
  }

  async saveBody(input: SaveBodyInput): Promise<DocumentSnapshot>;
  async saveBody(session: DocumentSession | string, body: string, expectedBodyRevision: string): Promise<DocumentSnapshot>;
  async saveBody(inputOrSession: SaveBodyInput | DocumentSession | string, bodyArgument?: string, expectedArgument?: string): Promise<DocumentSnapshot> {
    const input: SaveBodyInput = typeof inputOrSession === "object" && inputOrSession !== null && ("session" in inputOrSession || "grant" in inputOrSession)
      ? inputOrSession
      : { session: inputOrSession as DocumentSession | string, body: bodyArgument, expectedBodyRevision: expectedArgument ?? "" };
    const body = input.body ?? input.content;
    if (typeof body !== "string" || typeof input.expectedBodyRevision !== "string") throw new Error("A body and expected body revision are required.");
    return this.mutate(inputSession(input), async (path, parsed) => {
      const currentRevision = bodyRevision(parsed.body);
      if (currentRevision !== input.expectedBodyRevision) throw new DocumentConflictError("The document body changed before this save was applied.");
      const nextSource = rejoinAnnotationLedger(body, parsed.ledgerText ?? parsed.ledger);
      await atomicReplace(path, nextSource);
      return snapshotFromSource(path, nextSource);
    });
  }

  async appendEvent(input: AppendEventInput): Promise<DocumentSnapshot>;
  async appendEvent(session: DocumentSession | string, event: AnnotationEventInput, expectedBodyRevision?: string, expectedLedgerRevision?: string): Promise<DocumentSnapshot>;
  async appendEvent(inputOrSession: AppendEventInput | DocumentSession | string, eventArgument?: AnnotationEventInput, expectedBodyArgument?: string, expectedLedgerArgument?: string): Promise<DocumentSnapshot> {
    const input: AppendEventInput = typeof inputOrSession === "object" && inputOrSession !== null && ("session" in inputOrSession || "grant" in inputOrSession)
      ? inputOrSession
      : { session: inputOrSession as DocumentSession | string, event: eventArgument, expectedBodyRevision: expectedBodyArgument, expectedLedgerRevision: expectedLedgerArgument };
    const eventInput = sourceEvent(input);
    const expectedBodyRevision = input.expectedBodyRevision
      ?? (typeof input.expectedRevision === "string" ? input.expectedRevision : undefined)
      ?? (typeof eventInput.bodyRevision === "string" && eventInput.type !== "reply" && eventInput.type !== "resolve" && eventInput.type !== "reopen" && eventInput.type !== "edit" && eventInput.type !== "delete" ? eventInput.bodyRevision : undefined);
    return this.mutate(inputSession(input), async (path, parsed) => {
      const currentBodyRevision = bodyRevision(parsed.body);
      const currentLedgerRevision = ledgerRevision(parsed.ledgerText);
      if (expectedBodyRevision !== undefined && expectedBodyRevision !== currentBodyRevision) {
        throw new DocumentConflictError("The document body changed before this annotation was appended.");
      }
      if (input.expectedLedgerRevision !== undefined && input.expectedLedgerRevision !== currentLedgerRevision) {
        throw new DocumentConflictError("Annotations changed before this mutation was appended.");
      }
      if (eventInput.type === "comment") {
        if (expectedBodyRevision === undefined) throw new DocumentConflictError("A comment requires the body revision returned by its completed save.");
        if (!eventInput.anchor || typeof eventInput.anchor !== "object" || eventInput.anchor.bodyRevision !== currentBodyRevision) {
          throw new DocumentConflictError("The comment anchor does not match the current body revision.");
        }
      }
      if (eventInput.type === "ack" && typeof eventInput.bodyRevision !== "string") {
        throw new Error("An acknowledgement requires bodyRevision.");
      }
      const completed = completeEvent(eventInput, parsed.ledger, this.now);
      // Validate before touching disk. appendAnnotationEvent checks thread,
      // sequence, target and acknowledgement relationships as one transaction.
      const nextLedger = appendAnnotationEvent(parsed.ledger ?? createAnnotationLedger({
        type: "ledger",
        documentId: crypto.randomUUID(),
        baseBodyRevision: currentBodyRevision,
        createdAt: new Date(this.now()).toISOString(),
      }), completed);
      const nextEnvelope = parsed.ledgerText
        ? appendAnnotationEventToEnvelope(parsed.ledgerText, completed)
        : serializeAnnotationLedger(nextLedger);
      const nextSource = rejoinAnnotationLedger(parsed.body, nextEnvelope);
      await atomicReplace(path, nextSource);
      return snapshotFromSource(path, nextSource);
    });
  }

  appendAnnotation(input: AppendEventInput): Promise<DocumentSnapshot> { return this.appendEvent(input); }

  private eventAction(input: AppendEventInput, type: AnnotationEvent["type"]): Promise<DocumentSnapshot> {
    return this.appendEvent({ ...input, type, event: input.event ? { ...input.event, type } : undefined });
  }

  appendComment(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "comment"); }
  reply(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "reply"); }
  resolve(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "resolve"); }
  reopen(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "reopen"); }
  edit(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "edit"); }
  delete(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "delete"); }
  acknowledge(input: AppendEventInput): Promise<DocumentSnapshot> { return this.eventAction(input, "ack"); }

  async pendingEvents(session: DocumentSession | string, actor = "assistant"): Promise<PendingAnnotation[]> {
    const { source } = await this.readSource(session);
    try {
      const split = splitAnnotationLedger(source);
      if (split.ledger) validateAnnotationLedger(split.ledger);
      return pendingAnnotations(split.ledger ?? [], actor);
    } catch (error) {
      throw new DocumentReadOnlyError(undefined, errorMessage(error));
    }
  }

  async pending(session: DocumentSession | string, actor = "assistant"): Promise<PendingRead> {
    const snapshot = await this.read(session);
    if (snapshot.readOnly) throw new DocumentReadOnlyError(undefined, snapshot.ledgerError);
    const pending = await this.pendingEvents(session, actor);
    const acknowledgements = snapshot.annotations.acknowledgements;
    const acknowledgement = acknowledgements.find((value) => (value as { actor?: string }).actor === actor) ?? null;
    const header = snapshot.annotations.header;
    return { path: snapshot.path, documentId: typeof header?.documentId === "string" ? header.documentId : null, bodyRevision: snapshot.bodyRevision, ledgerRevision: snapshot.ledgerRevision, annotations: snapshot.annotations, pending, events: pending, maxSequence: snapshot.annotations.maxSequence, acknowledgement };
  }

  pendingRead(session: DocumentSession | string, actor = "assistant"): Promise<PendingRead> { return this.pending(session, actor); }
  pendingAnnotations(session: DocumentSession | string, actor = "assistant"): Promise<PendingAnnotation[]> { return this.pendingEvents(session, actor); }

  async threadValue(session: DocumentSession | string, threadId: string): Promise<DerivedThread> {
    const { source } = await this.readSource(session);
    try {
      const split = splitAnnotationLedger(source);
      if (split.ledger) validateAnnotationLedger(split.ledger);
      const thread = deriveAnnotationState(split.ledger ?? []).byThread.get(threadId);
      if (!thread) throw new Error(`Annotation thread not found: ${threadId}.`);
      return thread;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Annotation thread not found:")) throw error;
      throw new DocumentReadOnlyError(undefined, errorMessage(error));
    }
  }

  async thread(session: DocumentSession | string, threadId: string): Promise<ThreadRead> {
    const thread = await this.threadValue(session, threadId);
    return { path: (await this.read(session)).path, thread };
  }

  threadRead(session: DocumentSession | string, threadId: string): Promise<ThreadRead> { return this.thread(session, threadId); }

  readDocument(session: DocumentSession | string): Promise<DocumentSnapshot> { return this.read(session); }
  readExact(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }
  exportDocument(session: DocumentSession | string): Promise<string> { return this.exportExact(session); }

  /** Resolve a wikilink relative to the current document without consulting Recents. */
  async resolveWikilink(currentPath: string, rawTarget: string): Promise<string> {
    const current = await this.canonicalFor(currentPath);
    const target = rawTarget.trim();
    const withoutAlias = target.includes("|") ? target.slice(0, target.indexOf("|")) : target;
    const withoutFragment = withoutAlias.split("#", 1)[0];
    if (!withoutFragment) throw new DocumentNotFoundError("A wikilink target is required.");
    const roots = withoutFragment.startsWith("/")
      ? [withoutFragment]
      : [resolve(dirname(current), withoutFragment)];
    const candidates = roots.flatMap((candidate) => isMarkdown(candidate) ? [candidate] : [candidate, `${candidate}.md`, `${candidate}.markdown`]);
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return await realpath(candidate);
      } catch {}
    }
    throw new DocumentNotFoundError("Wikilink target does not exist.");
  }
}

export const FileDocumentGateway = DocumentService;
/** Named class alias for daemon code that treats the gateway as a service. */
export class DocumentGateway extends DocumentService {}
export class DocumentReviewService extends DocumentService {}
export const createDocumentService = (options?: DocumentServiceOptions): DocumentService => new DocumentService(options);
export const createDocumentGateway = (options?: DocumentServiceOptions): DocumentGateway => new DocumentGateway(options);
