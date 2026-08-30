import { describe, expect, test } from "bun:test";
import { Schema } from "@milkdown/kit/prose/model";
import {
  ANNOTATION_END,
  ANNOTATION_START,
  appendAnnotationEvent,
  appendAnnotationEventToEnvelope,
  bodyRevision,
  createAnchor,
  createAnnotationLedger,
  deriveAnnotationState,
  ledgerRevision,
  parseAnnotationLedger,
  renderedTextProjection,
  resolveAnchor,
  rejoinAnnotationLedger,
  serializeAnnotationEvent,
  serializeAnnotationLedger,
  splitAnnotationLedger,
  type AnnotationEvent,
  type AnnotationLedger,
} from "../src/core/annotation-ledger";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    image: { inline: true, group: "inline", atom: true, attrs: { src: { default: "" } } },
    text: { group: "inline" },
  },
  marks: {},
});

function text(value: string) {
  return schema.text(value);
}

function paragraph(...content: any[]) {
  return schema.nodes.paragraph.create(null, content);
}

function ledgerFor(body: string, events: AnnotationEvent[] = []): AnnotationLedger {
  return {
    header: {
      type: "ledger",
      documentId: "doc-test",
      baseBodyRevision: bodyRevision(body),
      createdAt: "2026-08-28T00:00:00.000Z",
    },
    events,
  };
}

function comment(body: string, seq = 1, actor = "hart", exact = "target"): AnnotationEvent {
  return {
    type: "comment",
    id: `c-${seq}`,
    seq,
    actor,
    createdAt: `2026-08-28T00:00:0${seq}.000Z`,
    anchor: {
      exact,
      prefix: "before ",
      suffix: " after",
      projectionStart: 7,
      projectionEnd: 7 + exact.length,
      bodyRevision: bodyRevision("body"),
    },
    body,
  };
}

describe("annotation ledger envelope", () => {
  test("puts a newly created ledger on its own terminal block", () => {
    const ledger = createAnnotationLedger(ledgerFor("Body without newline").header);
    const source = rejoinAnnotationLedger("Body without newline", ledger);
    expect(source).toContain("Body without newline\n\n<!-- wave-annotations:v1\n");
    expect(splitAnnotationLedger(source).ledger?.header.documentId).toBe(ledger.header.documentId);
  });
  test("round-trips a file with no ledger and hashes the empty ledger", () => {
    const source = "---\ntitle: Example\n---\n\n# Body\n";
    const split = splitAnnotationLedger(source);
    expect(split.ledger).toBeNull();
    expect(split.body).toBe(source);
    expect(rejoinAnnotationLedger(split.body, split.ledger)).toBe(source);
    expect(split.bodyRevision).toBe(bodyRevision(source));
    expect(split.ledgerRevision).toBe(ledgerRevision(""));
  });

  test("splits and rejoins a valid terminal JSONL envelope", () => {
    const body = "---\ntitle: Example\n---\n\n# Body\n";
    const ledger = ledgerFor(body, [comment("Please clarify.")]);
    const envelope = serializeAnnotationLedger(ledger);
    const source = body + envelope;
    const split = splitAnnotationLedger(source);

    expect(split.body).toBe(body);
    expect(split.ledger).toEqual(ledger);
    expect(split.ledgerText).toBe(envelope);
    expect(rejoinAnnotationLedger(split.body, split.ledgerText)).toBe(source);
    expect(rejoinAnnotationLedger("edited\n", split.ledgerText)).toBe("edited\n" + envelope);
  });

  test("appends an event without rewriting existing envelope bytes", () => {
    const body = "Body\n";
    const ledger = ledgerFor(body);
    const envelope = serializeAnnotationLedger(ledger).replaceAll("\n", "\r\n") + "\r\n";
    const event = comment("preserved", 1);
    const appended = appendAnnotationEventToEnvelope(envelope, event);
    expect(appended.replace(serializeAnnotationEvent(event) + "\r\n", "")).toBe(envelope);
    expect(parseAnnotationLedger(appended).events).toEqual([event]);
  });

  test("rejects acknowledgements beyond or below the actor watermark", () => {
    const first = comment("first", 1);
    const tooFar = { type: "ack", id: "ack-gap", seq: 100, actor: "assistant", throughSeq: 99, bodyRevision: bodyRevision("body"), createdAt: "now" } as const;
    expect(() => serializeAnnotationLedger(ledgerFor("", [first, tooFar]))).toThrow(/preceding ledger sequence/);
    const second = { ...comment("second", 2), id: "c-2" };
    const ack = { ...tooFar, id: "ack-1", seq: 3, throughSeq: 2 };
    const lower = { ...tooFar, id: "ack-2", seq: 4, throughSeq: 1 };
    expect(() => serializeAnnotationLedger(ledgerFor("", [first, second, ack, lower]))).toThrow(/lower an actor's watermark/);
  });

  test("rejects duplicate, non-terminal, and unterminated envelopes", () => {
    const line = JSON.stringify(ledgerFor("", [] as AnnotationEvent[]).header);
    const valid = `${ANNOTATION_START}\n${line}\n${ANNOTATION_END}`;
    expect(() => splitAnnotationLedger(valid + "\n" + valid)).toThrow(/duplicate annotation ledger starts/);
    expect(() => splitAnnotationLedger(valid + "\nmore text")).toThrow(/final non-whitespace/);
    expect(() => splitAnnotationLedger(`${ANNOTATION_START}\n${line}`)).toThrow(/unterminated/);
    expect(() => splitAnnotationLedger(`${line}\n${ANNOTATION_END}`)).toThrow(/no matching start/);
  });

  test("rejects sentinel text in a fenced code block", () => {
    const fenced = "```markdown\n" + ANNOTATION_START + "\n-->\n```\n";
    expect(() => splitAnnotationLedger(fenced)).toThrow(/fenced code block/);
    expect(() => splitAnnotationLedger("~~~\n" + ANNOTATION_END + "\n~~~\n")).toThrow(/fenced code block/);
  });

  test("escapes every double hyphen before placing JSON inside HTML comments", () => {
    const event = comment("The marker --> and a range -- must survive.");
    const serialized = serializeAnnotationEvent(event);
    expect(serialized).not.toContain("--");
    expect(JSON.parse(serialized)).toEqual(event);
    const parsed = parseAnnotationLedger(serializeAnnotationLedger(ledgerFor("", [event])));
    expect(parsed.events[0]).toEqual(event);
  });

  test("rejects malformed JSON and a missing ledger header", () => {
    expect(() => splitAnnotationLedger(`${ANNOTATION_START}\nnot json\n${ANNOTATION_END}`)).toThrow(/Malformed annotation JSON/);
    expect(() => splitAnnotationLedger(`${ANNOTATION_START}\n{}\n${ANNOTATION_END}`)).toThrow(/first annotation ledger line/);
  });

  test("rejects an unescaped raw HTML-comment terminator and duplicate event ids", () => {
    const header = JSON.stringify(ledgerFor("", []).header);
    const unsafe = `${ANNOTATION_START}\n${header}\n{"type":"comment","id":"c-1","seq":1,"actor":"hart","createdAt":"now","anchor":{"exact":"x --> y","prefix":"","suffix":"","projectionStart":0,"projectionEnd":1,"bodyRevision":"${bodyRevision("body")}"},"body":"x"}\n${ANNOTATION_END}`;
    expect(() => splitAnnotationLedger(unsafe)).toThrow(/unescaped HTML-comment terminator/);

    const first = comment("first");
    const duplicate = { ...comment("second", 2), id: first.id };
    expect(() => serializeAnnotationLedger(ledgerFor("", [first, duplicate]))).toThrow(/Duplicate annotation event id/);
    expect(appendAnnotationEvent(ledgerFor("", [first]), { ...comment("second", 2), id: "c-2" }).events).toHaveLength(2);
  });
});

describe("annotation event state", () => {
  test("derives immutable edits and deletes without losing event history", () => {
    const first = comment("Original", 1);
    const events: AnnotationEvent[] = [
      first,
      { type: "reply", id: "r-2", seq: 2, threadId: first.id, actor: "assistant", createdAt: "now", body: "Reply" },
      { type: "edit", id: "e-3", seq: 3, threadId: first.id, targetId: first.id, actor: "hart", createdAt: "now", body: "Revised" },
      { type: "edit", id: "e-4", seq: 4, threadId: first.id, targetId: "r-2", actor: "assistant", createdAt: "now", body: "Revised reply" },
      { type: "delete", id: "d-5", seq: 5, threadId: first.id, targetId: "r-2", actor: "assistant", createdAt: "now" },
    ];
    const state = deriveAnnotationState(ledgerFor("body", events));
    expect(state.events).toHaveLength(5);
    expect(state.threads[0].comment.body).toBe("Revised");
    expect(state.threads[0].replies).toHaveLength(0);
    expect(state.pending("codex").map((item) => item.event.type)).toEqual(["comment", "reply", "edit", "edit", "delete"]);
  });

  test("derives threads, resolution, acknowledgements, and actor-specific pending events", () => {
    const body = "body";
    const events: AnnotationEvent[] = [
      comment("Please clarify.", 1, "hart"),
      { type: "reply", id: "r-2", seq: 2, threadId: "c-1", actor: "codex", createdAt: "2026-08-28T00:00:02.000Z", body: "Done." },
      { type: "resolve", id: "x-3", seq: 3, threadId: "c-1", actor: "codex", createdAt: "2026-08-28T00:00:03.000Z" },
      { type: "reopen", id: "x-4", seq: 4, threadId: "c-1", actor: "hart", createdAt: "2026-08-28T00:00:04.000Z" },
      { type: "ack", id: "a-5", seq: 5, actor: "codex", throughSeq: 4, bodyRevision: bodyRevision(body), createdAt: "2026-08-28T00:00:05.000Z" },
      { type: "reply", id: "r-6", seq: 6, threadId: "c-1", actor: "hart", createdAt: "2026-08-28T00:00:06.000Z", body: "One more detail." },
    ];
    const state = deriveAnnotationState(ledgerFor(body, events));

    expect(state.maxSequence).toBe(6);
    expect(state.unresolvedCount).toBe(1);
    expect(state.threads[0].status).toBe("open");
    expect(state.threads[0].replies.map((reply) => reply.id)).toEqual(["r-2", "r-6"]);
    expect(state.acknowledgements.get("codex")?.throughSeq).toBe(4);
    expect(state.pending("codex").map((item) => item.event.id)).toEqual(["r-6"]);
    expect(state.pending("hart").map((item) => item.event.id)).toEqual(["r-2", "x-3"]);
  });
});

describe("rendered text projection and anchors", () => {
  test("uses UTF-16 offsets for emoji and maps them to ProseMirror positions", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("a😀b")), paragraph(text("next"))]);
    const projection = renderedTextProjection(doc);
    expect(projection.projection).toBe("a😀b\nnext");
    expect(projection.projection.slice(1, 3)).toBe("😀");
    expect(projection.positionAt(1)).toBe(2);
    expect(projection.positionAt(3)).toBe(4);

    const anchor = createAnchor(projection, 1, 3, bodyRevision("body"));
    expect(anchor.exact).toBe("😀");
    expect(anchor.projectionStart).toBe(1);
    expect(anchor.projectionEnd).toBe(3);
    expect(resolveAnchor(anchor, projection)).toMatchObject({ status: "resolved", projectionStart: 1, projectionEnd: 3, from: 2, to: 4 });
  });

  test("emits one separator between textblocks and U+FFFC for inline atoms", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("left"), schema.nodes.image.create({ src: "x" })), paragraph(text("right"))]);
    expect(renderedTextProjection(doc).projection).toBe("left\uFFFC\nright");
  });

  test("relocates a uniquely contextualized quote and orphans an ambiguous quote", () => {
    const original = renderedTextProjection(schema.topNodeType.create(null, [paragraph(text("x".repeat(70) + "before target after"))]));
    const anchor = createAnchor(original, 77, 83, bodyRevision("body"));
    const relocated = renderedTextProjection(schema.topNodeType.create(null, [paragraph(text("prefix " + "x".repeat(70) + "before target after"))]));
    expect(resolveAnchor(anchor, relocated)).toMatchObject({ status: "resolved", projectionStart: 84 });

    const ambiguous = renderedTextProjection(schema.topNodeType.create(null, [paragraph(text("prefix " + "x".repeat(70) + "before target after; " + "x".repeat(70) + "before target after"))]));
    const orphan = resolveAnchor(anchor, ambiguous);
    expect(orphan).toMatchObject({ status: "orphan", reason: "ambiguous" });
    expect((orphan as { matches: number[] }).matches).toHaveLength(2);
  });
});
