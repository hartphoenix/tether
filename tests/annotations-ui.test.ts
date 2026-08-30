import { expect, test } from "bun:test";
import { EditorState } from "@milkdown/kit/prose/state";
import { Schema } from "@milkdown/kit/prose/model";
import { JSDOM } from "jsdom";
import {
  actorColor,
  annotationUiPluginKey,
  createAnnotationDecorations,
  createAnnotationUi,
  projectDocument,
  resolveAnchor,
  type AnnotationThread,
  type AnnotationAnchor,
} from "../src/web/annotations-ui";

const bodyRevision = "sha256:" + "0".repeat(64);

function anchor(exact: string, values: Partial<AnnotationAnchor> = {}): AnnotationAnchor {
  return {
    exact,
    prefix: "",
    suffix: "",
    projectionStart: 999,
    projectionEnd: 999 + exact.length,
    bodyRevision,
    ...values,
  };
}

function installDom(): Window & typeof globalThis {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
  const nextWindow = dom.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: nextWindow,
    document: nextWindow.document,
    navigator: nextWindow.navigator,
    Node: nextWindow.Node,
    Element: nextWindow.Element,
    HTMLElement: nextWindow.HTMLElement,
    Event: nextWindow.Event,
    SVGElement: nextWindow.SVGElement,
    CSS: nextWindow.CSS,
    MutationObserver: nextWindow.MutationObserver,
    getComputedStyle: nextWindow.getComputedStyle,
  });
  return nextWindow;
}

function testSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
    },
  });
}

function documentWith(...paragraphs: string[]) {
  const schema = testSchema();
  return {
    schema,
    doc: schema.node("doc", null, paragraphs.map((text) => schema.node("paragraph", null, schema.text(text)))),
  };
}

function thread(overrides: Partial<AnnotationThread> = {}): AnnotationThread {
  return {
    id: "c-1",
    actor: "hart",
    createdAt: "2026-08-28T12:00:00.000Z",
    body: "Clarify this.",
    anchor: anchor("alpha", { suffix: " beta", projectionStart: 0, projectionEnd: 5 }),
    ...overrides,
  };
}

test("projects block text and resolves an anchor to ProseMirror ranges", () => {
  const { doc } = documentWith("alpha beta", "gamma");
  expect(projectDocument(doc).projection).toBe("alpha beta\ngamma");
  expect(resolveAnchor(doc, thread().anchor)).toEqual({
    start: 0,
    end: 5,
    ranges: [{ from: 1, to: 6 }],
  });
  expect(resolveAnchor(doc, anchor("beta", { prefix: "alpha ", suffix: "\ngamma" }))).toEqual({
    start: 6,
    end: 10,
    ranges: [{ from: 7, to: 11 }],
  });
});

test("ambiguous exact quotes become unresolved instead of attaching arbitrarily", () => {
  const { doc } = documentWith("same passage", "same passage");
  expect(resolveAnchor(doc, anchor("same passage"))).toBeNull();
  expect(createAnnotationDecorations(doc, [thread({ anchor: anchor("same passage") })]).find()).toHaveLength(0);
});

test("actor colors are deterministic and decorations carry thread identity", () => {
  const { doc } = documentWith("alpha beta");
  expect(actorColor("hart")).toBe(actorColor("hart"));
  expect(actorColor("hart")).not.toBe(actorColor("assistant"));
  const decorations = createAnnotationDecorations(doc, [thread()]).find();
  expect(decorations).toHaveLength(2);
  const highlight = decorations.find((decoration) => decoration.spec.annotationId === "c-1")!;
  expect(highlight.from).toBe(1);
  expect(highlight.to).toBe(6);
});

test("the rail orders threads, isolates orphans, and exposes resolve/reply controls", async () => {
  installDom();
  const root = document.createElement("div");
  document.body.append(root);
  let resolved = "";
  let replyBody = "";
  let edited = "";
  let deleted = "";
  let pending = -1;
  const ui = createAnnotationUi({
    root,
    onPendingCountChange: (count) => { pending = count; },
    onResolve: (value) => { resolved = value.id; },
    onReply: ({ body }) => { replyBody = body; },
    onEdit: ({ targetId, body }) => { edited = `${targetId}:${body}`; },
    onDelete: ({ targetId }) => { deleted = targetId; },
  });
  ui.setState({
    threads: [
      thread({
        id: "c-late",
        anchor: anchor("later", { projectionStart: 10, projectionEnd: 15 }),
        replies: [{ id: "r-agent", actor: "assistant", createdAt: "2026-08-28T12:05:00.000Z", body: "Choose a direction." }],
      }),
      thread({ id: "c-orphan", orphaned: true }),
      thread({ id: "c-resolved", resolved: true }),
    ],
  });
  expect(pending).toBe(1);
  expect(root.querySelector('[data-thread-id="c-late"]')).not.toBeNull();
  expect(root.querySelector('[data-thread-id="c-late"] .wm-thread-status')?.textContent).toBe("Open");
  expect(root.querySelector('[data-thread-id="c-late"] .wm-thread-excerpt')?.textContent).toBe("Choose a direction.");
  expect(root.querySelector(".wm-orphan-group [data-thread-id=\"c-orphan\"]")).not.toBeNull();
  expect(root.querySelector('[data-thread-id="c-orphan"] .wm-thread-location')?.textContent).toBe("Orphaned");
  expect(root.querySelector('[data-thread-id="c-orphan"] .wm-thread-status')?.textContent).toBe("Open");
  root.querySelector<HTMLButtonElement>('[data-thread-id="c-orphan"] .wm-thread-summary')!.click();
  expect(document.querySelector(".wm-thread-popover .wm-annotation-reply-form")).not.toBeNull();
  expect(root.querySelector('[data-thread-id="c-resolved"]')).toBeNull();
  const filter = root.querySelector<HTMLInputElement>(".wm-unresolved-filter input")!;
  expect(filter.parentElement?.textContent).toContain("Show resolved");
  filter.checked = true;
  filter.dispatchEvent(new Event("change", { bubbles: true }));
  expect(root.querySelector('[data-thread-id="c-resolved"]')).not.toBeNull();
  expect(root.querySelector('[data-thread-id="c-resolved"] .wm-thread-status')?.textContent).toBe("Resolved");
  const summary = root.querySelector<HTMLButtonElement>('[data-thread-id="c-late"] .wm-thread-summary')!;
  summary.click();
  const details = document.querySelector<HTMLElement>(".wm-thread-popover .wm-thread-details")!;
  expect(details.hidden).toBe(false);
  details.querySelector<HTMLButtonElement>(".wm-button-secondary")!.click();
  expect(resolved).toBe("c-late");
  const reply = details.querySelector<HTMLTextAreaElement>(".wm-annotation-reply-form textarea")!;
  reply.value = "Done.";
  details.querySelector<HTMLFormElement>(".wm-annotation-reply-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(replyBody).toBe("Done.");
  const editable = details.querySelector<HTMLElement>(".wm-editable-annotation")!;
  editable.querySelector<HTMLButtonElement>(".wm-inline-edit")!.click();
  editable.querySelector<HTMLTextAreaElement>("textarea")!.value = "Revised comment";
  editable.querySelector<HTMLButtonElement>(".wm-button-primary")!.click();
  await Promise.resolve();
  expect(edited).toBe("c-late:Revised comment");
  editable.querySelector<HTMLButtonElement>(".wm-button-danger")!.click();
  await Promise.resolve();
  expect(deleted).toBe("c-late");
  ui.destroy();
  expect(root.querySelector(".wm-annotation-rail")).toBeNull();
});

test("an open drawer expands threads inline while a closed drawer uses a canvas-bounded popover", () => {
  installDom();
  const root = document.createElement("div");
  const editorRoot = document.createElement("main");
  const trigger = document.createElement("button");
  editorRoot.append(trigger);
  document.body.append(editorRoot, root);
  editorRoot.getBoundingClientRect = () => ({ left: 10, top: 10, right: 900, bottom: 700, width: 890, height: 690, x: 10, y: 10, toJSON: () => ({}) });
  trigger.getBoundingClientRect = () => ({ left: 850, top: 650, right: 866, bottom: 666, width: 16, height: 16, x: 850, y: 650, toJSON: () => ({}) });
  const ui = createAnnotationUi({ root, editorRoot });
  ui.setState({ threads: [thread()] });

  ui.setRailOpen(true);
  root.querySelector<HTMLButtonElement>(".wm-thread-summary")!.click();
  expect(root.querySelector<HTMLElement>(".wm-thread-details")!.hidden).toBe(false);
  expect(document.querySelector(".wm-thread-popover")).toBeNull();

  ui.setRailOpen(false);
  ui.openThread("c-1", trigger);
  const popover = document.querySelector<HTMLElement>(".wm-thread-popover")!;
  expect(Number.parseFloat(popover.style.left)).toBeGreaterThanOrEqual(22);
  expect(Number.parseFloat(popover.style.left) + 340).toBeLessThanOrEqual(888);
  expect(Number.parseFloat(popover.style.top)).toBeGreaterThanOrEqual(22);
  ui.destroy();
});

test("comment composer validates and submits a supplied anchor", async () => {
  installDom();
  const root = document.createElement("div");
  document.body.append(root);
  let draft: { body: string; exact: string } | null = null;
  const ui = createAnnotationUi({
    root,
    onCreateComment: ({ body, anchor }) => { draft = { body, exact: anchor.exact }; },
  });
  ui.openCommentComposer(anchor("selected", { projectionStart: 1, projectionEnd: 9 }));
  const form = document.querySelector<HTMLFormElement>(".wm-annotation-form")!;
  form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Please revise.";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(draft as { body: string; exact: string } | null).toEqual({ body: "Please revise.", exact: "selected" });
  ui.destroy();
});

test("the plugin updates decorations from metadata without changing the document", () => {
  installDom();
  const { schema, doc } = documentWith("alpha beta");
  const ui = createAnnotationUi({ root: document.createElement("div") });
  const state = EditorState.create({ schema, doc, plugins: [ui.plugin] });
  const next = state.apply(state.tr.setMeta(annotationUiPluginKey, { threads: [thread()] }));
  expect(next.doc.eq(state.doc)).toBe(true);
  expect(annotationUiPluginKey.getState(next)?.decorations.find()).toHaveLength(2);
  ui.destroy();
});

test("ordinary footnote references open a read-only popover", () => {
  const nextWindow = installDom();
  const mount = document.createElement("div");
  const editorRoot = document.createElement("div");
  editorRoot.innerHTML = '<sup data-type="footnote_reference" data-label="one">[1]</sup><div data-type="footnote_definition" data-label="one">A plain footnote.</div>';
  document.body.append(mount, editorRoot);
  const ui = createAnnotationUi({ root: mount, editorRoot });
  const reference = editorRoot.querySelector<HTMLElement>("sup")!;
  reference.dispatchEvent(new nextWindow.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(editorRoot.querySelector(".wm-footnote-popover")?.textContent).toContain("A plain footnote.");
  ui.closeFootnotePopover();
  expect(editorRoot.querySelector(".wm-footnote-popover")).toBeNull();
  ui.destroy();
});
