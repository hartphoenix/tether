import { expect, test } from "bun:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { GapCursor } from "@milkdown/kit/prose/gapcursor";
import { Mapping } from "@milkdown/kit/prose/transform";
import { initialReaderSelection } from "../src/web/initial-selection";

const schema = new Schema({ nodes: {
  doc: { content: "block+" },
  paragraph: { content: "text*", group: "block" },
  heading: { content: "text*", group: "block" },
  blockquote: { content: "block+", group: "block" },
  image: { group: "block", atom: true, selectable: true },
  text: {},
} });
const image = () => schema.nodes.image!.create();
const heading = () => schema.nodes.heading!.create(null, schema.text("Title"));

test("leading images start with a collapsed text cursor without changing content or history", () => {
  const doc = schema.nodes.doc!.create(null, [image(), image(), heading()]);
  const original = doc.toJSON();
  const state = EditorState.create(initialReaderSelection({ doc }));
  expect(state.selection).toBeInstanceOf(TextSelection);
  expect(state.selection.empty).toBe(true);
  expect(state.selection.from).toBe(3);
  expect(state.selection.$from.parent.type.name).toBe("heading");
  expect(state.doc).toBe(doc);
  expect(state.doc.toJSON()).toEqual(original);
  expect(state.tr.docChanged).toBe(false);
  expect(state.tr.scrolledIntoView).toBe(false);
});

test("text-first and empty documents keep their usual initial cursor", () => {
  for (const first of [heading(), schema.nodes.paragraph!.create()]) {
    const doc = schema.nodes.doc!.create(null, [first, image()]);
    const normal = EditorState.create({ doc });
    const state = EditorState.create(initialReaderSelection({ doc }));
    expect(state.selection.eq(normal.selection)).toBe(true);
  }
  const options = { schema };
  expect(initialReaderSelection(options)).toBe(options);
});

test("finds text inside a nested block after a leading atom", () => {
  const doc = schema.nodes.doc!.create(null, [image(), schema.nodes.blockquote!.create(null, heading())]);
  const state = EditorState.create(initialReaderSelection({ doc }));
  expect(state.selection).toBeInstanceOf(TextSelection);
  expect(state.selection.$from.parent.textContent).toBe("Title");
});

test("atom-only documents have a valid empty gap selection without inserting text", () => {
  const doc = schema.nodes.doc!.create(null, [image(), image()]);
  const options = { doc };
  const state = EditorState.create(initialReaderSelection(options));
  expect(state.selection).toBeInstanceOf(GapCursor);
  expect(state.selection.empty).toBe(true);
  expect(state.selection.visible).toBe(false);
  expect(state.selection.map(doc, new Mapping())).toBeInstanceOf(GapCursor);
  expect(state.doc).toBe(doc);
});

test("explicit selections and later intentional image selections are preserved", () => {
  const doc = schema.nodes.doc!.create(null, [image(), heading()]);
  const selection = NodeSelection.create(doc, 0);
  const options = { doc, selection };
  expect(initialReaderSelection(options)).toBe(options);
  const state = EditorState.create(initialReaderSelection({ doc }));
  const clicked = state.apply(state.tr.setSelection(selection));
  expect(clicked.selection).toBe(selection);
  expect(clicked.doc).toBe(doc);
});
