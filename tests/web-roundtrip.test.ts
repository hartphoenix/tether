import { expect, test } from "bun:test";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { JSDOM } from "jsdom";
import { createAnnotationUi } from "../src/web/annotations-ui";
import { createReviewNote } from "../src/web/editor-commands";
import { incomingDiffPlugins } from "../src/web/incoming-diff";
import { prepareMarkdown, restoreMarkdown, wikilinkRoute } from "../src/core/markdown-codec";

const fixture = `---
title: Fixture
---

# Markdown fixture

<!-- retained comment -->

Link to [[another-note]].

| One | Two |
| --- | --- |
| A | B |
`;

test("wikilinks use an interceptable same-origin route and restore exactly", () => {
  const source = "See [[design/design-principles|Design principles]].";
  const prepared = prepareMarkdown(source);
  expect(prepared.editorMarkdown).toBe(`See [Design principles](${wikilinkRoute}design%2Fdesign-principles%7CDesign%20principles).`);
  expect(restoreMarkdown(prepared.editorMarkdown, "")).toBe(source);
});

test("reports Milkdown's representative Markdown normalization", async () => {
  const dom = new JSDOM('<!doctype html><div id="editor"></div>', { url: "http://localhost" });
  const window = dom.window as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    ShadowRoot: window.ShadowRoot,
    customElements: window.customElements,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });

  const { Crepe } = await import("@milkdown/crepe");
  const prepared = prepareMarkdown(fixture);
  const crepe = new Crepe({ root: document.querySelector("#editor"), defaultValue: prepared.editorMarkdown });
  await crepe.create();
  const serialized = restoreMarkdown(crepe.getMarkdown(), prepared.frontmatter);
  await crepe.destroy();

  expect(serialized).toContain("title: Fixture");
  expect(serialized.startsWith("---\ntitle: Fixture\n---\n")).toBe(true);
  expect(serialized).toContain("<!-- retained comment -->");
  expect(serialized).toContain("[[another-note]]");
  expect(serialized).toContain("| One | Two |");

  const annotationRoot = document.createElement("div");
  document.body.append(annotationRoot);
  const annotated = new Crepe({ root: annotationRoot, defaultValue: "Passage to annotate.\n" });
  await annotated.create();
  const view = annotated.editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)));
  expect(createReviewNote(view, "Check this assumption. ")).toEqual({ ok: true });
  const annotationMarkdown = annotated.getMarkdown();
  await annotated.destroy();

  expect(annotationMarkdown).toContain("Passage[^review-1]");
  expect(annotationMarkdown).toContain("[^review-1]: Check this assumption.");

  const integratedRoot = document.createElement("div");
  const railRoot = document.createElement("div");
  document.body.append(integratedRoot, railRoot);
  const annotationUi = createAnnotationUi({ root: railRoot, editorRoot: integratedRoot });
  const integrated = new Crepe({ root: integratedRoot, defaultValue: "Integrated startup.\n" });
  integrated.editor.use($prose(() => annotationUi.plugin)).use(incomingDiffPlugins);
  await integrated.create();
  expect(integrated.getMarkdown()).toContain("Integrated startup.");
  await integrated.destroy();
  annotationUi.destroy();
});
