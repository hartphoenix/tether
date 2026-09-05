import { expect, test } from "bun:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { JSDOM } from "jsdom";
import { codeBlockSelectionBounds, isCodeBlockTextSelection, normalizeStyle } from "../src/web/selection-ui";

test("normalizes safe tag style declarations", () => {
  expect(normalizeStyle(" font-size: 1.2em; color: #e7e9ec ")).toEqual({
    css: "font-size: 1.2em; color: #e7e9ec;",
  });
});

test("rejects layout escape and URL-bearing tag styles", () => {
  expect(normalizeStyle("position: fixed").error).toContain("not an editable style property");
  expect(normalizeStyle("background-color: url(https://example.com/x)").error).toContain("Invalid value");
});

test("identifies only nonempty selections contained by one code block", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "text*", group: "block" },
      code_block: { content: "text*", group: "block", code: true },
      text: {},
    },
  });
  const doc = schema.node("doc", null, [
    schema.node("code_block", null, schema.text("const value = 1;")),
    schema.node("paragraph", null, schema.text("outside")),
  ]);
  const state = EditorState.create({ schema, doc });

  expect(isCodeBlockTextSelection(TextSelection.create(doc, 1, 6))).toBe(true);
  expect(isCodeBlockTextSelection(TextSelection.create(doc, 3, 3))).toBe(false);
  expect(isCodeBlockTextSelection(TextSelection.create(doc, 19, 22))).toBe(false);
  expect(isCodeBlockTextSelection(state.selection)).toBe(false);
});

test("anchors a code-block tooltip to CodeMirror's rendered selection", () => {
  const dom = new JSDOM('<div class="milkdown-code-block"><i></i><i></i></div>');
  const block = dom.window.document.querySelector<HTMLElement>(".milkdown-code-block")!;
  const [first, second] = block.querySelectorAll<HTMLElement>("i");
  first!.className = "cm-selectionBackground";
  second!.className = "cm-selectionBackground";
  first!.getBoundingClientRect = () => ({ left: 120, top: 200, right: 180, bottom: 220, width: 60, height: 20, x: 120, y: 200, toJSON: () => ({}) });
  second!.getBoundingClientRect = () => ({ left: 80, top: 220, right: 150, bottom: 240, width: 70, height: 20, x: 80, y: 220, toJSON: () => ({}) });

  expect(codeBlockSelectionBounds(block)).toEqual({ left: 80, top: 200, right: 180, bottom: 240, width: 100, height: 40 });
});
