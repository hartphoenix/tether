import { afterAll, beforeAll, expect, test } from "bun:test";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { JSDOM } from "jsdom";
import { validateAnnotationEvent, type CommentEvent } from "../src/core/annotation-ledger";
import { PrivateStore } from "../src/storage/private-store";
import { createChangeReviewMenu } from "../src/web/change-review-menu";
import { bodyRevision } from "../src/core/index";

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

test("stored revision chains paint each agent's surviving text with its resolved color", () => {
  const store = new PrivateStore(), id = store.ensureDocument("/tmp/attributed-reader.md").id;
  const base = "First old.\n\nDivider.\n\nLast old.\n";
  const middle = "First Alice.\n\nDivider.\n\nLast old.\n";
  const final = "First Alice.\n\nDivider.\n\nLast Bob.\n";
  store.bodyRevisions.record(id, base, null, 1);
  store.bodyRevisions.record(id, middle, "alice", 2);
  store.bodyRevisions.record(id, final, "bob", 3);
  const identities = store.identities.resolve(["alice", "bob"]);
  expect(identities[0]!.colorSlot).not.toBe(identities[1]!.colorSlot);
  review.setReviewColors(author => author === "alice" ? "#ff0000" : author === "bob" ? "#0000ff" : undefined);
  load(base);
  review.startIncomingDiff(crepe.editor, final, bodyRevision(base));
  const spans = review.authorsFromChain(crepe.editor, store.bodyRevisions.chain(id, bodyRevision(base)), body => body)!;
  expect(spans.map(span => span.authorId)).toEqual(["alice", "bob"]);
  review.setReviewAuthors(view, spans);
  const painted = [...view.dom.querySelectorAll<HTMLElement>(".tether-review-inserted")];
  expect(painted.some(node => node.textContent?.includes("Alice") && node.getAttribute("style")?.includes("#ff0000"))).toBe(true);
  expect(painted.some(node => node.textContent?.includes("Bob") && node.getAttribute("style")?.includes("#0000ff"))).toBe(true);
  const menu = createChangeReviewMenu({ getView: () => view, closeMenus: () => {}, onComment: () => {}, identity: id => store.identities.resolve([id])[0] });
  const headings = () => {
    const target = document.createElement("span");
    target.className = "tether-review-before";
    target.dataset.hunk = String(review.reviewState(view)!.hunks[0]!.fromB);
    return menu.items(view, { target, clientX: 0, clientY: 0 } as unknown as MouseEvent)!.filter(item => "kind" in item);
  };
  expect(headings().map(item => item.label)).toEqual(["alice"]);
  expect(headings()[0]!.badge?.querySelector("svg")).toBeTruthy();
  store.identities.rename("alice", "Renamed Alice");
  expect(headings().map(item => item.label)).toEqual(["Renamed Alice"]);
  const first = review.reviewState(view)!.hunks[0]!;
  review.setReviewAuthors(view, [{ from: first.fromB, to: first.fromB + 1, authorId: "alice" }, { from: first.fromB + 1, to: first.toB, authorId: "bob" }]);
  expect(headings().map(item => item.label)).toEqual(["Renamed Alice", "bob"]);
  review.setReviewAuthors(view, null);
  expect(headings().map(item => item.label)).toEqual(["Author unknown"]);
  menu.destroy();
  expect(review.authorsFromChain(crepe.editor, store.bodyRevisions.chain(id, bodyRevision(base)), body => body)).toEqual(spans);
  review.endIncomingDiff(view);
  review.setReviewColors(() => undefined);
  store.close();
});

test("whole-word display fills retained letters without changing exact author spans", () => {
  for (const [base, next, word] of [
    ["## Design\n", "## Diagnosis\n", "Diagnosis"],
    ["A cat.\n", "A bobcat.\n", "bobcat"],
    ["A cat.\n", "A cats.\n", "cats"],
    ["Use `Design`.\n", "Use `Diagnosis`.\n", "Diagnosis"],
  ]) {
    load(base!);
    const original = view.state.doc;
    review.startIncomingDiff(crepe.editor, next!);
    const spans = review.attributeRevisions(original, [{ doc: view.state.doc, authorId: "alice" }]);
    const exact = JSON.stringify(spans);
    review.setReviewColors(id => id === "alice" ? "purple" : undefined);
    review.setReviewAuthors(view, spans);
    const painted = [...view.dom.querySelectorAll<HTMLElement>(".tether-review-inserted")];
    expect(painted.map(node => node.textContent).join("")).toContain(word!);
    expect(painted.every(node => node.style.getPropertyValue("--tether-review-color") === "purple")).toBe(true);
    expect(JSON.stringify(review.reviewState(view)!.authors)).toBe(exact);
    review.setReviewAuthors(view, spans.map(span => ({ ...span, authorId: null })));
    expect([...view.dom.querySelectorAll<HTMLElement>(".tether-review-inserted")].every(node => node.style.getPropertyValue("--tether-review-color").startsWith("var(--wm-color-primary"))).toBe(true);
  }
  review.endIncomingDiff(view);
  review.setReviewColors(() => undefined);
});

test("a genuinely mixed-author word is neutral and retains both contributors", () => {
  load("A cat.\n");
  const base = view.state.doc;
  const middle = review.parseIncomingDocument(crepe.editor, "A cats.\n")!;
  review.startIncomingDiff(crepe.editor, "A bobcats.\n");
  const spans = review.attributeRevisions(base, [{doc: middle, authorId: "alice"}, {doc: view.state.doc, authorId: "bob"}]);
  review.setReviewColors(id => id === "alice" ? "purple" : id === "bob" ? "blue" : undefined);
  review.setReviewAuthors(view, spans);
  expect(new Set(spans.map(span => span.authorId))).toEqual(new Set(["alice", "bob"]));
  const painted = [...view.dom.querySelectorAll<HTMLElement>(".tether-review-inserted")];
  expect(painted.map(node => node.textContent).join("")).toContain("bobcats");
  expect(painted.every(node => node.style.getPropertyValue("--tether-review-color").startsWith("var(--wm-color-primary"))).toBe(true);
  review.endIncomingDiff(view);
  review.setReviewColors(() => undefined);
});

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

const table = '| Name | Value |\n| --- | --- |\n| Alpha | one |\n| Beta | two |\n| Gamma | three |\n';

test('table cell changes accept or revert once without introducing structural changes', () => {
  const updated = table.replace('| Beta | two |', '| Changed | updated |');
  for (const action of ['seen', 'revert']) {
    load(table);
    review.startIncomingDiff(crepe.editor, updated);
    const state = review.reviewState(view)!;
    expect(state.hunks).toHaveLength(1);
    const current = view.state.doc;
    if (action === 'seen') review.markHunkSeen(view, state.hunks[0]!);
    else review.revertHunk(view, state.hunks[0]!);
    expect(review.reviewState(view)).toBeNull();
    expect(view.state.doc.eq(action === 'seen' ? current : state.base)).toBe(true);
  }
});

test('table alignment changes group by row and each row clears in one action', () => {
  load(table);
  review.startIncomingDiff(crepe.editor, table.replace('| --- | --- |', '| :--- | ---: |'));
  const current = view.state.doc;
  expect(review.reviewState(view)!.hunks).toHaveLength(4);
  for (let remaining = 4; remaining > 0; remaining--) {
    review.markHunkSeen(view, review.reviewState(view)!.hunks[0]!);
    expect(review.reviewState(view)?.hunks.length ?? 0).toBe(remaining - 1);
    expect(view.state.doc).toBe(current);
  }
});

test('accepting one table row leaves other changed rows under review', () => {
  load(table);
  review.startIncomingDiff(crepe.editor, table.replace('one', 'first').replace('three', 'last'));
  expect(review.reviewState(view)!.hunks).toHaveLength(2);
  review.markHunkSeen(view, review.reviewState(view)!.hunks[0]!);
  expect(review.reviewState(view)!.hunks).toHaveLength(1);
  review.revertHunk(view, review.reviewState(view)!.hunks[0]!);
  expect(review.reviewState(view)).toBeNull();
  expect(view.state.doc.eq(review.parseIncomingDocument(crepe.editor, table.replace('one', 'first'))!)).toBe(true);
});

test('inserted and deleted table rows accept or revert without affecting neighboring rows', () => {
  for (const updated of [table.replace('| Beta | two |\n', ''), table.replace('| Beta | two |', '| Added | new |\n| Beta | two |')]) {
    for (const action of ['seen', 'revert']) {
      load(table);
      review.startIncomingDiff(crepe.editor, updated);
      const state = review.reviewState(view)!;
      expect(state.hunks).toHaveLength(1);
      const current = view.state.doc;
      if (action === 'seen') review.markHunkSeen(view, state.hunks[0]!);
      else review.revertHunk(view, state.hunks[0]!);
      expect(review.reviewState(view)).toBeNull();
      expect(view.state.doc.eq(action === 'seen' ? current : state.base)).toBe(true);
    }
  }
});

for (const marker of ['-', '*', '+', '1.', '1)', '- [ ]', '1. [ ]']) {
  test(`${marker} list edits accept and revert cleanly`, () => {
    const base = `${marker} Alpha unchanged\n${marker} Beta unchanged\n${marker} Gamma unchanged\n`;
    const next = base.replace('Beta unchanged', 'Beta updated').replace(`${marker} Gamma`, `${marker} Inserted item\n${marker} Gamma`);
    load(base);
    review.startIncomingDiff(crepe.editor, next);
    const current = view.state.doc;
    const state = review.reviewState(view)!;
    expect(state.hunks.length).toBeGreaterThan(0);
    for (let i = 0; i < 10 && review.reviewState(view); i++) review.markHunkSeen(view, review.reviewState(view)!.hunks[0]!);
    expect(review.reviewState(view)).toBeNull();
    expect(view.state.doc).toBe(current);
    load(base);
    review.startIncomingDiff(crepe.editor, next);
    for (let i = 0; i < 10 && review.reviewState(view); i++) review.revertHunk(view, review.reviewState(view)!.hunks[0]!);
    expect(review.reviewState(view)).toBeNull();
    expect(view.state.doc.eq(state.base)).toBe(true);
  });
}

test('ordered insertion marks only the new item, not automatic renumbering', () => {
  const base = '1. First unchanged item\n1. Middle original item\n1. Last unchanged item\n';
  load(base);
  review.startIncomingDiff(crepe.editor, base.replace('1. Last', '1. Added item\n1. Last'));
  const state = review.reviewState(view)!;
  expect(state.hunks).toHaveLength(1);
  const hunk = state.hunks[0]!;
  expect(view.state.doc.textBetween(hunk.fromB, hunk.toB)).toBe('Added item');
  review.revertHunk(view, hunk);
  expect(review.reviewState(view)).toBeNull();
  expect(view.state.doc.eq(state.base)).toBe(true);
  load(base);
  review.startIncomingDiff(crepe.editor, base.replace(/^1\./, '5.'));
  expect(review.reviewState(view)?.hunks.length).toBeGreaterThan(0);
  review.endIncomingDiff(view);
});
