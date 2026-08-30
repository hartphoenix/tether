import { createHash } from "node:crypto";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";

/** The line-oriented markers are intentionally boring and versioned. */
export const ANNOTATION_LEDGER_VERSION = 1;
export const ANNOTATION_START = "<!-- wave-annotations:v1";
export const ANNOTATION_END = "-->";

export type Revision = `sha256:${string}`;

export type AnnotationAnchor = {
  exact: string;
  prefix: string;
  suffix: string;
  projectionStart: number;
  projectionEnd: number;
  bodyRevision: string;
};

export type LedgerHeaderEvent = {
  type: "ledger";
  documentId: string;
  baseBodyRevision: string;
  createdAt: string;
};

export type CommentEvent = {
  type: "comment";
  id: string;
  seq: number;
  actor: string;
  createdAt: string;
  anchor: AnnotationAnchor;
  body: string;
};

export type ReplyEvent = {
  type: "reply";
  id: string;
  seq: number;
  threadId: string;
  actor: string;
  createdAt: string;
  body: string;
};

export type ResolveEvent = {
  type: "resolve";
  id: string;
  seq: number;
  threadId: string;
  actor: string;
  createdAt: string;
};

export type ReopenEvent = {
  type: "reopen";
  id: string;
  seq: number;
  threadId: string;
  actor: string;
  createdAt: string;
};

export type EditEvent = {
  type: "edit";
  id: string;
  seq: number;
  targetId: string;
  threadId: string;
  actor: string;
  createdAt: string;
  body: string;
};

export type DeleteEvent = {
  type: "delete";
  id: string;
  seq: number;
  targetId: string;
  threadId: string;
  actor: string;
  createdAt: string;
};

export type AcknowledgeEvent = {
  type: "ack";
  id: string;
  seq: number;
  actor: string;
  throughSeq: number;
  bodyRevision: string;
  createdAt: string;
};

export type ReviewEvent = CommentEvent | ReplyEvent | ResolveEvent | ReopenEvent | EditEvent | DeleteEvent;
export type AnnotationEvent = ReviewEvent | AcknowledgeEvent;

export type AnnotationLedger = {
  header: LedgerHeaderEvent;
  events: AnnotationEvent[];
};

export type AnnotationSplit = {
  body: string;
  ledger: AnnotationLedger | null;
  /** The exact source bytes from the start sentinel through end of file. */
  ledgerText: string | null;
  /** Alias useful to callers that want to preserve an existing envelope. */
  envelope: string | null;
  bodyRevision: string;
  ledgerRevision: string;
};

export type AnnotationLedgerErrorCode =
  | "missing-end"
  | "duplicate-start"
  | "duplicate-end"
  | "stray-end"
  | "non-terminal"
  | "fenced-sentinel"
  | "missing-header"
  | "malformed-json"
  | "empty-event"
  | "invalid-event"
  | "invalid-sequence"
  | "duplicate-id"
  | "missing-thread"
  | "invalid-ack";

export class AnnotationLedgerError extends Error {
  readonly code: AnnotationLedgerErrorCode;
  readonly line?: number;

  constructor(code: AnnotationLedgerErrorCode, message: string, line?: number) {
    super(message);
    this.name = "AnnotationLedgerError";
    this.code = code;
    this.line = line;
  }
}

type SourceLine = {
  content: string;
  start: number;
  end: number;
};

function sourceLines(source: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    let content = source.slice(start, newline < 0 ? source.length : newline);
    if (content.endsWith("\r")) content = content.slice(0, -1);
    result.push({ content, start, end });
    start = end;
  }
  return result;
}

function fenceOpening(line: string): { character: "`" | "~"; length: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { character: match[2][0] as "`" | "~", length: match[2].length };
}

function fenceClosing(line: string, fence: { character: "`" | "~"; length: number }): boolean {
  const escaped = fence.character === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`).test(line);
}

function hashBytes(value: string): Revision {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Hashes the complete editable source (frontmatter included). */
export function bodyRevision(body: string): Revision {
  return hashBytes(body);
}

export const computeBodyRevision = bodyRevision;

/** Hashes exact envelope bytes. An absent ledger hashes as empty bytes. */
export function ledgerRevision(ledgerText: string | null | undefined): Revision {
  return hashBytes(ledgerText ?? "");
}

export const computeLedgerRevision = ledgerRevision;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, line?: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AnnotationLedgerError("invalid-event", `Annotation ${field} must be a non-empty string.`, line);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string, line?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AnnotationLedgerError("invalid-sequence", `Annotation ${field} must be a positive integer.`, line);
  }
  return value;
}

function requiredRevision(value: unknown, field: string, line?: number): string {
  const revision = requiredString(value, field, line);
  if (!/^sha256:[0-9a-f]{64}$/.test(revision)) {
    throw new AnnotationLedgerError("invalid-event", `Annotation ${field} must be a sha256 revision.`, line);
  }
  return revision;
}

function validateAnchor(value: unknown, line?: number): AnnotationAnchor {
  if (!isRecord(value)) {
    throw new AnnotationLedgerError("invalid-event", "A comment anchor must be an object.", line);
  }
  const exact = requiredString(value.exact, "anchor.exact", line);
  const prefix = requiredStringAllowEmpty(value.prefix, "anchor.prefix", line);
  const suffix = requiredStringAllowEmpty(value.suffix, "anchor.suffix", line);
  const projectionStart = requiredOffset(value.projectionStart, "anchor.projectionStart", line);
  const projectionEnd = requiredOffset(value.projectionEnd, "anchor.projectionEnd", line);
  if (projectionEnd < projectionStart) {
    throw new AnnotationLedgerError("invalid-event", "An anchor end must not precede its start.", line);
  }
  const bodyRevisionValue = requiredRevision(value.bodyRevision, "anchor.bodyRevision", line);
  return { exact, prefix, suffix, projectionStart, projectionEnd, bodyRevision: bodyRevisionValue };
}

function requiredStringAllowEmpty(value: unknown, field: string, line?: number): string {
  if (typeof value !== "string") {
    throw new AnnotationLedgerError("invalid-event", `Annotation ${field} must be a string.`, line);
  }
  return value;
}

function requiredOffset(value: unknown, field: string, line?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AnnotationLedgerError("invalid-event", `Annotation ${field} must be a UTF-16 offset.`, line);
  }
  return value;
}

function validateHeader(value: unknown, line?: number): LedgerHeaderEvent {
  if (!isRecord(value) || value.type !== "ledger") {
    throw new AnnotationLedgerError("missing-header", "The first annotation ledger line must be a ledger header.", line);
  }
  return {
    type: "ledger",
    documentId: requiredString(value.documentId, "documentId", line),
    baseBodyRevision: requiredRevision(value.baseBodyRevision, "baseBodyRevision", line),
    createdAt: requiredString(value.createdAt, "createdAt", line),
  };
}

/** Validate one event. Thread and sequence relationships are checked by validateAnnotationLedger. */
export function validateAnnotationEvent(value: unknown, line?: number): AnnotationEvent {
  if (!isRecord(value)) {
    throw new AnnotationLedgerError("invalid-event", "An annotation event must be a JSON object.", line);
  }
  const type = value.type;
  const id = requiredString(value.id, "id", line);
  const seq = requiredPositiveInteger(value.seq, "seq", line);
  const actor = requiredString(value.actor, "actor", line);
  const createdAt = requiredString(value.createdAt, "createdAt", line);

  if (type === "comment") {
    const body = requiredString(value.body, "body", line);
    if (!body.trim()) throw new AnnotationLedgerError("invalid-event", "A comment body cannot be empty.", line);
    return { type, id, seq, actor, createdAt, anchor: validateAnchor(value.anchor, line), body };
  }
  if (type === "reply") {
    const body = requiredString(value.body, "body", line);
    if (!body.trim()) throw new AnnotationLedgerError("invalid-event", "A reply body cannot be empty.", line);
    return { type, id, seq, actor, createdAt, threadId: requiredString(value.threadId, "threadId", line), body };
  }
  if (type === "resolve" || type === "reopen") {
    return { type, id, seq, actor, createdAt, threadId: requiredString(value.threadId, "threadId", line) } as ResolveEvent | ReopenEvent;
  }
  if (type === "edit") {
    const body = requiredString(value.body, "body", line);
    if (!body.trim()) throw new AnnotationLedgerError("invalid-event", "An edited annotation body cannot be empty.", line);
    return { type, id, seq, actor, createdAt, targetId: requiredString(value.targetId, "targetId", line), threadId: requiredString(value.threadId, "threadId", line), body };
  }
  if (type === "delete") {
    return { type, id, seq, actor, createdAt, targetId: requiredString(value.targetId, "targetId", line), threadId: requiredString(value.threadId, "threadId", line) };
  }
  if (type === "ack") {
    const throughSeq = requiredPositiveInteger(value.throughSeq, "throughSeq", line);
    return {
      type,
      id,
      seq,
      actor,
      throughSeq,
      bodyRevision: requiredRevision(value.bodyRevision, "bodyRevision", line),
      createdAt,
    };
  }
  throw new AnnotationLedgerError("invalid-event", `Unknown annotation event type: ${String(type)}.`, line);
}

/** Validate a parsed ledger and return a normalized copy. */
export function validateAnnotationLedger(value: AnnotationLedger): AnnotationLedger {
  if (!value || !value.header || !Array.isArray(value.events)) {
    throw new AnnotationLedgerError("missing-header", "An annotation ledger needs a header and events.");
  }
  const header = validateHeader(value.header);
  const events: AnnotationEvent[] = [];
  const ids = new Set<string>();
  let previousSeq = 0;
  const threads = new Set<string>();
  const editableEvents = new Map<string, { type: "comment" | "reply"; threadId: string; deleted: boolean }>();
  const acknowledgementWatermarks = new Map<string, number>();

  for (const [index, rawEvent] of value.events.entries()) {
    const event = validateAnnotationEvent(rawEvent, index + 2);
    if (ids.has(event.id)) throw new AnnotationLedgerError("duplicate-id", `Duplicate annotation event id: ${event.id}.`, index + 2);
    ids.add(event.id);
    if (event.seq <= previousSeq) {
      throw new AnnotationLedgerError("invalid-sequence", "Annotation sequence numbers must increase strictly.", index + 2);
    }
    if (event.type === "comment") {
      threads.add(event.id);
      editableEvents.set(event.id, { type: "comment", threadId: event.id, deleted: false });
    }
    if (event.type === "reply" || event.type === "resolve" || event.type === "reopen") {
      if (!threads.has(event.threadId)) {
        throw new AnnotationLedgerError("missing-thread", `Annotation event refers to missing thread: ${event.threadId}.`, index + 2);
      }
    }
    if (event.type === "reply") editableEvents.set(event.id, { type: "reply", threadId: event.threadId, deleted: false });
    if (event.type === "edit" || event.type === "delete") {
      const target = editableEvents.get(event.targetId);
      if (!target || target.threadId !== event.threadId || target.deleted) {
        throw new AnnotationLedgerError("missing-thread", `Annotation event refers to a missing or deleted editable event: ${event.targetId}.`, index + 2);
      }
      if (event.type === "delete") target.deleted = true;
    }
    if (event.type === "ack") {
      if (event.throughSeq > previousSeq) {
        throw new AnnotationLedgerError("invalid-ack", "An acknowledgement cannot advance beyond the preceding ledger sequence.", index + 2);
      }
      const watermark = acknowledgementWatermarks.get(event.actor) ?? 0;
      if (event.throughSeq < watermark) {
        throw new AnnotationLedgerError("invalid-ack", "An acknowledgement cannot lower an actor's watermark.", index + 2);
      }
      acknowledgementWatermarks.set(event.actor, event.throughSeq);
    }
    events.push(event);
    previousSeq = event.seq;
  }
  return { header, events };
}

function parseEventLines(lines: SourceLine[], startIndex: number, endIndex: number): AnnotationLedger {
  if (endIndex <= startIndex + 1) {
    throw new AnnotationLedgerError("missing-header", "The annotation envelope contains no JSONL events.", startIndex + 1);
  }
  const values: unknown[] = [];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const content = lines[index].content;
    if (!content.trim()) throw new AnnotationLedgerError("empty-event", "Blank lines are not valid annotation JSONL.", index + 1);
    if (content.includes(ANNOTATION_END)) {
      throw new AnnotationLedgerError("malformed-json", "An annotation JSONL line contains an unescaped HTML-comment terminator.", index + 1);
    }
    try {
      values.push(JSON.parse(content));
    } catch {
      throw new AnnotationLedgerError("malformed-json", `Malformed annotation JSON on line ${index + 1}.`, index + 1);
    }
  }
  const header = validateHeader(values[0], startIndex + 2);
  const events = values.slice(1).map((value, index) => validateAnnotationEvent(value, startIndex + 3 + index));
  return validateAnnotationLedger({ header, events });
}

/**
 * Parse and validate a complete terminal envelope. This accepts only an
 * envelope beginning at offset zero; splitAnnotationLedger handles a file.
 */
export function parseAnnotationLedger(envelope: string): AnnotationLedger {
  const split = splitAnnotationLedger(envelope);
  if (!split.ledger || split.body.length !== 0) {
    throw new AnnotationLedgerError("invalid-event", "Expected a complete annotation envelope.");
  }
  return split.ledger;
}

/**
 * Separate the terminal ledger before any Markdown/frontmatter processing.
 * Sentinel-looking lines inside fenced code are errors rather than ignored
 * metadata, preventing a code example from being mistaken for hidden state.
 */
export function splitAnnotationLedger(source: string): AnnotationSplit {
  const lines = sourceLines(source);
  const starts: number[] = [];
  const ends: number[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].content;
    if (fence) {
      // `-->` is valid ordinary code (for example in a comparison or an
      // HTML example). Only an exact reserved sentinel line is suspicious.
      if (content === ANNOTATION_START || content === ANNOTATION_END) {
        throw new AnnotationLedgerError("fenced-sentinel", "Annotation sentinel text is not allowed inside a fenced code block.", index + 1);
      }
      if (fenceClosing(content, fence)) fence = null;
      continue;
    }
    const opening = fenceOpening(content);
    if (opening) {
      fence = opening;
      continue;
    }
    if (content === ANNOTATION_START) starts.push(index);
    if (content === ANNOTATION_END) ends.push(index);
  }

  if (fence) throw new AnnotationLedgerError("missing-end", "A Markdown code fence is unterminated.");
  if (starts.length > 1) throw new AnnotationLedgerError("duplicate-start", "The Markdown contains duplicate annotation ledger starts.");
  if (ends.length > 1) throw new AnnotationLedgerError("duplicate-end", "The Markdown contains duplicate annotation ledger ends.");
  if (starts.length === 0 && ends.length === 0) {
    return { body: source, ledger: null, ledgerText: null, envelope: null, bodyRevision: bodyRevision(source), ledgerRevision: ledgerRevision(null) };
  }
  if (starts.length === 0) throw new AnnotationLedgerError("stray-end", "An annotation ledger end has no matching start.");
  if (ends.length === 0) throw new AnnotationLedgerError("missing-end", "The annotation ledger is unterminated.");
  if (ends[0] <= starts[0]) throw new AnnotationLedgerError("stray-end", "The annotation ledger end precedes its start.");

  const endOfEndLine = lines[ends[0]].end;
  if (source.slice(endOfEndLine).trim() !== "") {
    throw new AnnotationLedgerError("non-terminal", "The annotation ledger must be the final non-whitespace block.", ends[0] + 1);
  }
  const ledgerText = source.slice(lines[starts[0]].start);
  const ledger = parseEventLines(lines, starts[0], ends[0]);
  const body = source.slice(0, lines[starts[0]].start);
  return {
    body,
    ledger,
    ledgerText,
    envelope: ledgerText,
    bodyRevision: bodyRevision(body),
    ledgerRevision: ledgerRevision(ledgerText),
  };
}

/** Escape every literal double hyphen so an event cannot terminate the HTML comment. */
export function serializeAnnotationEvent(event: AnnotationEvent): string {
  const validated = validateAnnotationEvent(event);
  const line = JSON.stringify(validated).replaceAll("--", "\\u002d\\u002d");
  if (line.includes("-->") || line.includes("--")) {
    throw new AnnotationLedgerError("invalid-event", "Serialized annotation JSON contains an unsafe HTML-comment terminator.");
  }
  return line;
}

export function serializeLedgerHeader(header: LedgerHeaderEvent): string {
  const validated = validateHeader(header);
  const line = JSON.stringify(validated).replaceAll("--", "\\u002d\\u002d");
  if (line.includes("-->") || line.includes("--")) {
    throw new AnnotationLedgerError("invalid-event", "Serialized ledger header contains an unsafe HTML-comment terminator.");
  }
  return line;
}

export function serializeAnnotationLedger(value: AnnotationLedger): string {
  const ledger = validateAnnotationLedger(value);
  const lines = [ANNOTATION_START, serializeLedgerHeader(ledger.header), ...ledger.events.map(serializeAnnotationEvent), ANNOTATION_END];
  return lines.join("\n");
}

export const serializeLedger = serializeAnnotationLedger;

export function rejoinAnnotationLedger(body: string, ledger: AnnotationLedger | string | null | undefined): string {
  if (ledger == null) return body;
  const separator = body.length > 0 && !body.endsWith("\n") && !body.endsWith("\r") ? "\n\n" : "";
  return body + separator + (typeof ledger === "string" ? ledger : serializeAnnotationLedger(ledger));
}

/** Insert one validated event while preserving every existing envelope byte. */
export function appendAnnotationEventToEnvelope(envelope: string, event: AnnotationEvent): string {
  const ledger = parseAnnotationLedger(envelope);
  appendAnnotationEvent(ledger, event);
  const end = envelope.lastIndexOf(ANNOTATION_END);
  const lineStart = envelope.lastIndexOf("\n", end - 1) + 1;
  if (lineStart <= 0 || envelope.slice(lineStart, end) !== "") {
    throw new AnnotationLedgerError("missing-end", "The annotation ledger end sentinel is not on its own line.");
  }
  const lineBreak = lineStart >= 2 && envelope.slice(lineStart - 2, lineStart) === "\r\n" ? "\r\n" : "\n";
  return envelope.slice(0, lineStart) + serializeAnnotationEvent(event) + lineBreak + envelope.slice(lineStart);
}

export function createAnnotationLedger(header: LedgerHeaderEvent, events: AnnotationEvent[] = []): AnnotationLedger {
  return validateAnnotationLedger({ header, events });
}

/** Return a validated ledger with one immutable event appended. */
export function appendAnnotationEvent(ledger: AnnotationLedger, event: AnnotationEvent): AnnotationLedger {
  const current = validateAnnotationLedger(ledger);
  const next = validateAnnotationEvent(event);
  const lastSequence = current.events.at(-1)?.seq ?? 0;
  if (next.seq <= lastSequence) {
    throw new AnnotationLedgerError("invalid-sequence", "An appended annotation event must advance the ledger sequence.");
  }
  return validateAnnotationLedger({ header: current.header, events: [...current.events, next] });
}

export const appendEvent = appendAnnotationEvent;

function ledgerAndEvents(value: AnnotationLedger | AnnotationEvent[]): { header?: LedgerHeaderEvent; events: AnnotationEvent[] } {
  if (Array.isArray(value)) return { events: value };
  return { header: value.header, events: value.events };
}

export type DerivedThread = {
  id: string;
  comment: CommentEvent;
  replies: ReplyEvent[];
  status: "open" | "resolved";
  latestEvent: ReviewEvent;
  orphan?: AnchorResolution;
  deleted?: boolean;
};

export type PendingAnnotation = {
  event: ReviewEvent;
  thread: DerivedThread;
};

export type DerivedAnnotationState = {
  header?: LedgerHeaderEvent;
  events: AnnotationEvent[];
  threads: DerivedThread[];
  byThread: ReadonlyMap<string, DerivedThread>;
  acknowledgements: ReadonlyMap<string, AcknowledgeEvent>;
  maxSequence: number;
  unresolvedCount: number;
  pending: (actor: string) => PendingAnnotation[];
};

/** Derive display state and actor-specific pending packets from immutable events. */
export function deriveAnnotationState(value: AnnotationLedger | AnnotationEvent[], projection?: RenderedTextProjection): DerivedAnnotationState {
  const { header, events: rawEvents } = ledgerAndEvents(value);
  const events = rawEvents.map((event) => validateAnnotationEvent(event));
  const comments = new Map<string, DerivedThread>();
  const acknowledgements = new Map<string, AcknowledgeEvent>();
  let maxSequence = 0;

  for (const event of events) {
    maxSequence = Math.max(maxSequence, event.seq);
    if (event.type === "comment") {
      comments.set(event.id, {
        id: event.id,
        comment: event,
        replies: [],
        status: "open",
        latestEvent: event,
        ...(projection ? { orphan: resolveAnchor(event.anchor, projection) } : {}),
      });
    } else if (event.type === "reply") {
      const thread = comments.get(event.threadId);
      if (!thread) continue;
      thread.replies.push(event);
      thread.latestEvent = event;
    } else if (event.type === "resolve" || event.type === "reopen") {
      const thread = comments.get(event.threadId);
      if (!thread) continue;
      thread.status = event.type === "resolve" ? "resolved" : "open";
      thread.latestEvent = event;
    } else if (event.type === "edit" || event.type === "delete") {
      const thread = comments.get(event.threadId);
      if (!thread) continue;
      if (event.targetId === thread.comment.id) {
        if (event.type === "edit") thread.comment = { ...thread.comment, body: event.body };
        else thread.deleted = true;
      } else {
        const replyIndex = thread.replies.findIndex((reply) => reply.id === event.targetId);
        if (replyIndex >= 0) {
          if (event.type === "edit") thread.replies[replyIndex] = { ...thread.replies[replyIndex], body: event.body };
          else thread.replies.splice(replyIndex, 1);
        }
      }
      thread.latestEvent = event;
    } else if (event.type === "ack") {
      const previous = acknowledgements.get(event.actor);
      if (!previous || event.throughSeq > previous.throughSeq || (event.throughSeq === previous.throughSeq && event.seq > previous.seq)) {
        acknowledgements.set(event.actor, event);
      }
    }
  }

  const threads = [...comments.values()].sort((a, b) => a.comment.seq - b.comment.seq);
  const threadMap: ReadonlyMap<string, DerivedThread> = comments;
  const pending = (actor: string): PendingAnnotation[] => {
    const watermark = acknowledgements.get(actor)?.throughSeq ?? 0;
    return events
      .filter((event): event is ReviewEvent => event.type !== "ack" && event.seq > watermark && event.actor !== actor)
      .sort((a, b) => a.seq - b.seq)
      .flatMap((event) => {
        const threadId = event.type === "comment" ? event.id : event.threadId;
        const thread = comments.get(threadId);
        return thread ? [{ event, thread }] : [];
      });
  };

  return {
    header,
    events,
    threads,
    byThread: threadMap,
    acknowledgements,
    maxSequence,
    unresolvedCount: threads.filter((thread) => !thread.deleted && thread.status === "open").length,
    pending,
  };
}

export const deriveState = deriveAnnotationState;

export function pendingAnnotations(value: AnnotationLedger | AnnotationEvent[], actor: string): PendingAnnotation[] {
  return deriveAnnotationState(value).pending(actor);
}

export const pending = pendingAnnotations;

export type ProjectionSegment = {
  kind: "text" | "atom" | "separator";
  projectionStart: number;
  projectionEnd: number;
  from: number;
  to: number;
};

export type RenderedTextProjection = {
  projection: string;
  /** Alias for consumers that call the value renderedText. */
  renderedText: string;
  segments: ProjectionSegment[];
  /** One ProseMirror position for every UTF-16 boundary in projection. */
  positions: number[];
  positionAt: (offset: number) => number;
};

type NodeLike = {
  isText?: boolean;
  isInline?: boolean;
  isTextblock?: boolean;
  isAtom?: boolean;
  isLeaf?: boolean;
  nodeSize: number;
  text?: string | null;
  forEach?: (fn: (node: NodeLike, offset: number, index: number) => void) => void;
};

function isTextblock(node: NodeLike): boolean {
  return node.isTextblock === true;
}

function appendProjectionUnit(
  output: { text: string; segments: ProjectionSegment[]; positions: number[] },
  kind: ProjectionSegment["kind"],
  text: string,
  from: number,
  to: number,
): void {
  const projectionStart = output.text.length;
  output.text += text;
  const projectionEnd = output.text.length;
  output.segments.push({ kind, projectionStart, projectionEnd, from, to });
  if (output.positions.length === 0) output.positions.push(from);
  // The preceding separator ends at the previous block's boundary, while
  // the next unit begins at its own ProseMirror position. Keep this boundary
  // exact so decoration ranges can start on the next text node.
  else output.positions[output.positions.length - 1] = from;
  for (let index = 1; index <= text.length; index += 1) {
    output.positions.push(index === text.length ? to : from + index);
  }
}

function appendInline(
  node: NodeLike,
  nodePosition: number,
  output: { text: string; segments: ProjectionSegment[]; positions: number[] },
): void {
  if (node.isText) {
    const text = node.text ?? "";
    appendProjectionUnit(output, "text", text, nodePosition, nodePosition + text.length);
    return;
  }
  if (node.isInline) {
    appendProjectionUnit(output, "atom", "\uFFFC", nodePosition, nodePosition + node.nodeSize);
    return;
  }
  node.forEach?.((child, offset) => appendInline(child, nodePosition + 1 + offset, output));
}

/**
 * Build the canonical rendered-text projection used by quote anchors. Text
 * offsets are JavaScript UTF-16 offsets, matching ProseMirror positions.
 */
export function renderedTextProjection(node: ProseMirrorNode): RenderedTextProjection {
  const root = node as unknown as NodeLike;
  const output = { text: "", segments: [] as ProjectionSegment[], positions: [] as number[] };
  const blocks: Array<{ node: NodeLike; position: number }> = [];

  const collectBlocks = (current: NodeLike, position: number, rootNode = false): void => {
    if (!rootNode && isTextblock(current)) {
      blocks.push({ node: current, position });
      return;
    }
    current.forEach?.((child, offset) => collectBlocks(child, position + 1 + offset));
  };
  collectBlocks(root, -1, true);

  blocks.forEach(({ node: block, position }, index) => {
    if (index > 0) {
      const previous = blocks[index - 1];
      const separatorPosition = previous.position + previous.node.nodeSize - 1;
      appendProjectionUnit(output, "separator", "\n", separatorPosition, separatorPosition);
    }
    block.forEach?.((child, offset) => appendInline(child, position + 1 + offset, output));
  });

  // Empty projections still have one valid boundary position (the document start).
  if (output.positions.length === 0) output.positions.push(0);
  const positionAt = (offset: number): number => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > output.text.length) {
      throw new RangeError(`Projection offset ${offset} is outside 0..${output.text.length}.`);
    }
    return output.positions[offset] ?? output.positions[output.positions.length - 1];
  };
  return { projection: output.text, renderedText: output.text, segments: output.segments, positions: output.positions, positionAt };
}

export const createRenderedTextProjection = renderedTextProjection;
export const canonicalRenderedTextProjection = renderedTextProjection;

export function canonicalRenderedText(node: ProseMirrorNode): string {
  return renderedTextProjection(node).projection;
}

function codePointPrefix(value: string, count: number): string {
  return Array.from(value).slice(-count).join("");
}

function codePointSuffix(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}

export function createAnchor(
  projection: RenderedTextProjection | string,
  start: number,
  end: number,
  sourceBodyRevision: string,
): AnnotationAnchor {
  const text = typeof projection === "string" ? projection : projection.projection;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) {
    throw new RangeError("An annotation selection must be a non-empty UTF-16 range inside the projection.");
  }
  const exact = text.slice(start, end);
  return {
    exact,
    prefix: codePointPrefix(text.slice(0, start), 64),
    suffix: codePointSuffix(text.slice(end), 64),
    projectionStart: start,
    projectionEnd: end,
    bodyRevision: sourceBodyRevision,
  };
}

export const createAnnotationAnchor = createAnchor;

export type AnchorResolution =
  | { status: "resolved"; projectionStart: number; projectionEnd: number; from?: number; to?: number }
  | { status: "orphan"; reason: "quote-not-found" | "ambiguous"; matches: number[] };

function matchingContext(text: string, anchor: AnnotationAnchor, start: number, end: number): boolean {
  // A stored context is bounded by the original document edge. Compare the
  // candidate's immediate context at the stored length so appending content
  // after an end-of-document anchor does not invalidate that anchor.
  const prefixLength = Array.from(anchor.prefix).length;
  const suffixLength = Array.from(anchor.suffix).length;
  const prefix = prefixLength === 0 ? "" : codePointPrefix(text.slice(0, start), prefixLength);
  const suffix = codePointSuffix(text.slice(end), suffixLength);
  return prefix === anchor.prefix && suffix === anchor.suffix;
}

/** Resolve exact quote anchors, making ambiguity explicit instead of guessing. */
export function resolveAnchor(anchor: AnnotationAnchor, projection: RenderedTextProjection | string): AnchorResolution {
  const text = typeof projection === "string" ? projection : projection.projection;
  const atStart = anchor.projectionStart;
  const atEnd = anchor.projectionEnd;
  if (
    Number.isSafeInteger(atStart) &&
    Number.isSafeInteger(atEnd) &&
    atStart >= 0 &&
    atEnd >= atStart &&
    atEnd <= text.length &&
    text.slice(atStart, atEnd) === anchor.exact
  ) {
    return {
      status: "resolved",
      projectionStart: atStart,
      projectionEnd: atEnd,
      ...(typeof projection === "string" ? {} : { from: projection.positionAt(atStart), to: projection.positionAt(atEnd) }),
    };
  }

  const matches: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const match = text.indexOf(anchor.exact, from);
    if (match < 0) break;
    const end = match + anchor.exact.length;
    if (matchingContext(text, anchor, match, end)) matches.push(match);
    from = match + Math.max(anchor.exact.length, 1);
  }
  if (matches.length !== 1) {
    return { status: "orphan", reason: matches.length === 0 ? "quote-not-found" : "ambiguous", matches };
  }
  const match = matches[0];
  const end = match + anchor.exact.length;
  return {
    status: "resolved",
    projectionStart: match,
    projectionEnd: end,
    ...(typeof projection === "string" ? {} : { from: projection.positionAt(match), to: projection.positionAt(end) }),
  };
}

export const resolveAnnotationAnchor = resolveAnchor;
