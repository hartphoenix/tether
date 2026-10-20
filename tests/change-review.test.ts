import { afterAll, beforeAll, expect, test } from "bun:test";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { JSDOM } from "jsdom";
import { validateAnnotationEvent, type CommentEvent } from "../src/core/annotation-ledger";

let crepe: import("@milkdown/crepe").Crepe;
let view: EditorView;
let review: typeof import("../src/web/incoming-diff");

beforeAll(async () => {
  const { window } = new JSDOM('<!doctype html><div id="editor"></div>', { url: "http://localhost", pretendToBeVisual: true });
  Object.defineProperty(window.navigator, "hardwareConcurrency", { value: 2 });
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot, customElements: window.customElements,
    DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  review = await import("../src/web/incoming-diff");
  const { Crepe } = await import("@milkdown/crepe");
  crepe = new Crepe({ root: document.querySelector("#editor"), defaultValue: "Ready." });
  crepe.editor.use(review.incomingDiffPlugins);
  await crepe.create();
  view = crepe.editor.action(ctx => ctx.get(editorViewCtx));
});
afterAll(async () => { await crepe?.destroy(); });

function load(markdown: string) {
  const doc = review.parseIncomingDocument(crepe.editor, markdown)!;
  review.endIncomingDiff(view);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
}
const text = () => view.state.doc.textContent;

const before = "The 12 Lucide-style SVGs come from six concept sheets. Go icons shows them.\n\nAn unrelated paragraph stays.\n";
const after = "Two rounds of icon exploration produced 47 candidates. Go icons groups them.\n\nAn unrelated paragraph stays.\n";

test("review adopts the incoming document and groups nearby changes into one hunk", () => {
  load(before);
  review.startIncomingDiff(crepe.editor, after, "sha256:" + "1".repeat(64));
  expect(text()).toBe(review.parseIncomingDocument(crepe.editor, after)!.textContent);
  const state = review.reviewState(view)!;
  expect(state.changes.length).toBeGreaterThan(1);
  expect(state.hunks).toHaveLength(1);
  expect(state.hunks[0]!.inline).toBe(true);
  expect(state.baseRevision).toBe("sha256:" + "1".repeat(64));
});

test("inserted text is decorated in whole words", () => {
  const words = [...view.dom.querySelectorAll(".tether-review-inserted")].map(node => node.textContent);
  expect(words.join("|")).toContain("Two");
  expect(words.every(word => !/^wo\b/.test(word ?? ""))).toBe(true);
  expect(view.dom.textContent).not.toContain("Lucide");
});

test("toggling shows the earlier wording in place with removed words ghosted", () => {
  const state = review.reviewState(view)!;
  review.toggleHunks(view, [state.hunks[0]!]);
  const widget = view.dom.querySelector<HTMLElement>(".tether-review-before")!;
  expect(widget.textContent).toContain("12 Lucide-style SVGs");
  expect(widget.querySelector(".tether-review-ghost")?.textContent).toBeTruthy();
  expect(view.dom.querySelector(".tether-review-hidden")?.textContent).toContain("47 candidates");
  expect(review.hunkBeforeText(view, review.reviewState(view)!.hunks[0]!)).toContain("12 Lucide-style SVGs");
  review.toggleHunks(view, [review.reviewState(view)!.hunks[0]!]);
  expect(view.dom.querySelector(".tether-review-before")).toBeNull();
});

test("typing is blocked while reviewing, and marking the last hunk seen ends review", () => {
  const doc = view.state.doc;
  view.dispatch(view.state.tr.insertText("x", 1));
  expect(view.state.doc).toBe(doc);
  review.markHunkSeen(view, review.reviewState(view)!.hunks[0]!);
  expect(review.reviewState(view)).toBeNull();
  expect(text()).toContain("47 candidates");
});

test("reverting a hunk restores its earlier wording in the document", () => {
  load(before);
  review.startIncomingDiff(crepe.editor, after);
  review.revertHunk(view, review.reviewState(view)!.hunks[0]!);
  expect(review.reviewState(view)).toBeNull();
  expect(text()).toBe(review.parseIncomingDocument(crepe.editor, before)!.textContent);
});

test("separate paragraphs make separate hunks, and changes arriving mid-review keep the baseline", () => {
  load("First paragraph alpha.\n\nMiddle stays.\n\nLast paragraph omega.\n");
  review.startIncomingDiff(crepe.editor, "First paragraph beta.\n\nMiddle stays.\n\nLast paragraph omega.\n");
  expect(review.reviewState(view)!.hunks).toHaveLength(1);
  review.startIncomingDiff(crepe.editor, "First paragraph beta.\n\nMiddle stays.\n\nLast paragraph gamma.\n");
  const state = review.reviewState(view)!;
  expect(state.hunks).toHaveLength(2);
  expect(state.base.textContent).toContain("alpha");
  review.endIncomingDiff(view);
});

test("a new paragraph is a block hunk whose comment range is its own text", () => {
  load("Kept.\n");
  review.startIncomingDiff(crepe.editor, "Kept.\n\nA brand new paragraph.\n");
  const hunk = review.reviewState(view)!.hunks[0]!;
  expect(hunk.inline).toBe(false);
  const range = review.hunkCommentRange(view, hunk);
  expect(view.state.doc.textBetween(range.from, range.to)).toBe("A brand new paragraph.");
  review.endIncomingDiff(view);
});

test("attribution credits each inserted span to the revision that wrote it", () => {
  const parse = (markdown: string) => review.parseIncomingDocument(crepe.editor, markdown)!;
  const base = parse("One two three.\n");
  const spans = review.attributeRevisions(base, [
    { doc: parse("One two three four.\n"), authorId: "agent-a" },
    { doc: parse("Zero one two three four.\n"), authorId: "agent-b" },
  ]);
  const final = parse("Zero one two three four.\n");
  const byAuthor = (id: string) => spans.filter(span => span.authorId === id).map(span => final.textBetween(span.from, span.to)).join("");
  expect(byAuthor("agent-a")).toContain("four");
  expect(byAuthor("agent-b")).toContain("Zero");
});

test("double secondary taps pair only when close in time and space", () => {
  const pair = review.createDoubleSecondaryTap(450, 32);
  expect(pair(10, 10, 0)).toBe(false);
  expect(pair(14, 12, 200)).toBe(true);
  expect(pair(14, 12, 300)).toBe(false);
  expect(pair(200, 12, 400)).toBe(false);
  expect(pair(200, 12, 1000)).toBe(false);
});

test("comment anchors accept earlier wording", () => {
  const anchor = { exact: "Two", prefix: "", suffix: "", projectionStart: 0, projectionEnd: 3, bodyRevision: "sha256:" + "2".repeat(64), before: { exact: "The", bodyRevision: "sha256:" + "1".repeat(64) } };
  const comment = (value: unknown) => ({ type: "comment", id: "a-1", seq: 1, actor: "human", createdAt: "2026-10-20T00:00:00.000Z", body: "Why?", anchor: value });
  expect((validateAnnotationEvent(comment(anchor)) as CommentEvent).anchor.before).toEqual(anchor.before);
  expect(() => validateAnnotationEvent(comment({ ...anchor, before: { exact: "The" } }))).toThrow();
});
