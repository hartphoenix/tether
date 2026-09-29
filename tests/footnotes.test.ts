import { expect, test } from "bun:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { history, undo } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { insertFootnote, createFootnoteOrderingPlugin } from "../src/web/footnotes";

const schema = new Schema({ nodes: {
  doc: { content: "block+" }, text: { group: "inline" },
  paragraph: { content: "inline*", group: "block" },
  footnote_reference: { inline: true, atom: true, group: "inline", attrs: { label: {}, number: { default: null } } },
  footnote_definition: { content: "block+", group: "block", attrs: { label: {}, number: { default: null } } },
} });
function editor(from = 1, to = from) {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("selected words remain"))]);
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, from, to), plugins: [history(), createFootnoteOrderingPlugin()] });
  return { get state() { return state; }, editable: true, focus() {}, dispatch(tr: Parameters<EditorView["dispatch"]>[0]) { state = state.apply(tr); } } as unknown as EditorView;
}
test("footnote follows a selection and appends its definition in one undo step", () => {
  const view = editor(1, 15), original = view.state.doc;
  expect(insertFootnote(view, "First paragraph.\n\nSecond paragraph.")).toEqual({ ok: true });
  expect(view.state.doc.firstChild!.child(1).attrs.label).toMatch(/^note-/);
  expect(view.state.doc.firstChild!.textContent).toBe("selected words remain");
  expect(view.state.doc.firstChild!.child(1).attrs.number).toBe(1);
  expect(view.state.doc.lastChild!.type.name).toBe("footnote_definition");
  expect(view.state.doc.lastChild!.childCount).toBe(2);
  expect(undo(view.state, tr => view.dispatch(tr))).toBe(true);
  expect(view.state.doc.eq(original)).toBe(true);
});
test("stale selections and empty content do not change the document", () => {
  const view = editor(), selection = view.state.selection;
  expect(insertFootnote(view, "  ").ok).toBe(false);
  view.dispatch(view.state.tr.insertText("new", 1));
  expect(insertFootnote(view, "Body", selection).ok).toBe(false);
});
test("middle insertion renumbers without changing identifiers and sorts definitions", () => {
  const view = editor(2);
  insertFootnote(view, "First.");
  const first = view.state.doc.lastChild!.attrs.label;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 15)));
  insertFootnote(view, "Last.");
  const last = view.state.doc.lastChild!.attrs.label;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
  insertFootnote(view, "Middle.");
  const middle = view.state.doc.child(view.state.doc.childCount-2).attrs.label;
  const refs: string[] = [], definitions: string[] = [];
  view.state.doc.descendants(node => {
    if(node.type.name === "footnote_reference") refs.push(`${node.attrs.label}:${node.attrs.number}`);
    if(node.type.name === "footnote_definition") definitions.push(node.attrs.label);
  });
  expect(refs).toEqual([`${first}:1`, `${middle}:2`, `${last}:3`]);
  expect(definitions).toEqual([first, middle, last]);
  expect(undo(view.state, tr => view.dispatch(tr))).toBe(true);
});
test("automatic labels are distinct and remain stable after later insertion", () => {
  const view=editor();
  insertFootnote(view, "Automatic.");
  const label=view.state.doc.firstChild!.firstChild!.attrs.label;
  expect(label).toMatch(/^note-[a-f0-9]{8}$/);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,1)));
  insertFootnote(view, "Earlier.");
  expect(view.state.doc.firstChild!.child(1).attrs.label).toBe(label);
  expect(view.state.doc.firstChild!.child(1).attrs.number).toBe(2);
});
test("normalization leaves Crepe's empty trailing paragraph after definitions", () => {
  const view=editor();
  insertFootnote(view, "A note.");
  view.dispatch(view.state.tr.insert(view.state.doc.content.size,schema.node("paragraph")));
  const before=view.state.doc;
  view.dispatch(view.state.tr.setMeta("normalizeFootnotes",true));
  expect(view.state.doc.eq(before)).toBe(true);
  expect(view.state.doc.lastChild!.type.name).toBe("paragraph");
  expect(view.state.doc.child(view.state.doc.childCount-2).attrs.label).toMatch(/^note-/);
});
