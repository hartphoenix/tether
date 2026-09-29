import { describe, expect, test } from "bun:test";
import { Schema, type Mark } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createReviewNote } from "../src/web/editor-commands";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    footnote_definition: { content: "block+", group: "block", attrs: { label: { default: "" } } },
    footnote_reference: { inline: true, atom: true, group: "inline", attrs: { label: { default: "" } } },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: {},
    link: { attrs: { href: { default: "" }, title: { default: null } } },
  },
});

function text(value: string, marks: readonly Mark[] = []) {
  return schema.text(value, marks);
}

function paragraph(...content: any[]) {
  return schema.nodes.paragraph.create(null, content);
}

function definition(label: string, value: string) {
  return schema.nodes.footnote_definition.create(
    { label },
    schema.nodes.paragraph.create(null, text(value)),
  );
}

function reference(label: string) {
  return schema.nodes.footnote_reference.create({ label });
}

function makeView(doc = schema.topNodeType.createAndFill()!, selection?: TextSelection | NodeSelection) {
  let current = EditorState.create({ schema, doc, selection });
  const view = {
    get state() {
      return current;
    },
    dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
      current = current.apply(transaction);
    },
  } as unknown as EditorView;
  return view;
}

describe("review note commands", () => {
  test("allocates labels case-insensitively across definitions and orphan references", () => {
    const doc = schema.topNodeType.create(null, [
      paragraph(text("before "), reference("REVIEW-1"), text(" "), reference("review-2")),
      definition("review-1", "existing"),
    ]);
    const view = makeView(doc, TextSelection.create(doc, 1, 7));
    expect(createReviewNote(view, "  first\n\n note  ")).toEqual({ ok: true });

    const labels: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === "footnote_reference" || node.type.name === "footnote_definition") labels.push(node.attrs.label);
    });
    expect(labels).toContain("review-3");
    expect(view.state.doc.childCount).toBe(3);
  });

  test("rejects empty and non-text notes", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("passage"))]);
    const view = makeView(doc, TextSelection.create(doc, 1, 8));
    expect(createReviewNote(view, " \n\t ")).toEqual({ ok: false, reason: "A review note cannot be empty." });
    expect(createReviewNote(view, 42)).toEqual({ ok: false, reason: "A review note must be text." });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(createReviewNote(view, "note")).toEqual({
      ok: false,
      reason: "Select a passage before adding a review note.",
    });
  });

});
