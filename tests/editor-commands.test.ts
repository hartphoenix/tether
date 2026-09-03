import { describe, expect, test } from "bun:test";
import { Schema, type Mark } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  createReviewNote,
  getSelectionTags,
  removeTag,
  setTagEnabled,
  updateTag,
  type TagDescriptor,
} from "../src/web/editor-commands";

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

function tag(view: EditorView, id: string): TagDescriptor {
  const result = getSelectionTags(view).find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing tag ${id}`);
  return result;
}

describe("wave markdown editor commands", () => {
  test("detects and removes a mixed mark", () => {
    const strong = schema.marks.strong.create();
    const doc = schema.topNodeType.create(null, [
      paragraph(text("a", [strong]), text("b"), text("c", [strong])),
    ]);
    const view = makeView(doc, TextSelection.create(doc, 1, 4));
    const descriptor = tag(view, "mark:strong");

    expect(descriptor.state).toBe("mixed");
    expect(removeTag(view, descriptor)).toEqual({ ok: true });
    expect(view.state.doc.textContent).toBe("abc");
    expect(view.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
  });

  test("reports and applies available tags", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("plain"))]);
    const view = makeView(doc, TextSelection.create(doc, 1, 6));
    const descriptor = tag(view, "mark:strong");

    expect(descriptor.state).toBe("off");
    expect(setTagEnabled(view, descriptor, true)).toEqual({ ok: true });
    expect(tag(view, "mark:strong").state).toBe("on");
  });

  test("tracks tags enabled for future typing at a cursor", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("plain"))]);
    const view = makeView(doc, TextSelection.create(doc, 3));
    expect(setTagEnabled(view, tag(view, "mark:strong"), true)).toEqual({ ok: true });
    expect(tag(view, "mark:strong").state).toBe("on");
    expect(removeTag(view, tag(view, "mark:strong"))).toEqual({ ok: true });
    expect(tag(view, "mark:strong").state).toBe("off");
  });

  test("resolves a collapsed cursor to a maximal mark range", () => {
    const strong = schema.marks.strong.create();
    const doc = schema.topNodeType.create(null, [paragraph(text("abc", [strong]))]);
    const view = makeView(doc, TextSelection.create(doc, 2));
    const descriptor = tag(view, "mark:strong");

    expect(descriptor.state).toBe("on");
    expect(descriptor.range).toEqual({ from: 1, to: 4 });
    expect(removeTag(view, descriptor)).toEqual({ ok: true });
  });

  test("rejects a stale descriptor before mutating the new document", () => {
    const strong = schema.marks.strong.create();
    const doc = schema.topNodeType.create(null, [paragraph(text("abc", [strong]))]);
    const view = makeView(doc, TextSelection.create(doc, 1, 4));
    const descriptor = tag(view, "mark:strong");
    view.dispatch(view.state.tr.insertText("x", 1));

    const before = view.state.doc.toJSON();
    const result = removeTag(view, descriptor);
    expect(result.ok).toBe(false);
    expect(view.state.doc.toJSON()).toEqual(before);
  });

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

  test("does not classify ordinary footnotes as review annotations", () => {
    const doc = schema.topNodeType.create(null, [paragraph(reference("source-1")), definition("source-1", "citation")]);
    const view = makeView(doc, NodeSelection.create(doc, 1));
    expect(getSelectionTags(view).some((descriptor) => descriptor.kind === "review")).toBe(false);
  });

  test("removes a shared definition only after its last reference", () => {
    const doc = schema.topNodeType.create(null, [
      paragraph(reference("review-1"), text(" and "), reference("review-1")),
      definition("review-1", "shared"),
    ]);
    let view = makeView(doc, NodeSelection.create(doc, 1));
    expect(removeTag(view, tag(view, "review:review-1"))).toEqual({ ok: true });
    expect(view.state.doc.descendants((node) => node.type.name === "footnote_definition")).toBeUndefined();
    expect(view.state.doc.childCount).toBe(2);

    // The second reference follows the remaining " and " text.
    view = makeView(view.state.doc, NodeSelection.create(view.state.doc, 6));
    expect(removeTag(view, tag(view, "review:review-1"))).toEqual({ ok: true });
    let definitions = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === "footnote_definition") definitions += 1;
    });
    expect(definitions).toBe(0);
  });

  test("updates review note text without renaming its label", () => {
    const doc = schema.topNodeType.create(null, [
      paragraph(reference("review-1")),
      definition("review-1", "old note"),
    ]);
    const view = makeView(doc, NodeSelection.create(doc, 1));
    const descriptor = tag(view, "review:review-1");
    expect(updateTag(view, descriptor, "  new\n note ")).toEqual({ ok: true });
    expect(view.state.doc.lastChild?.textContent).toBe("new note");
    expect(updateTag(view, tag(view, "review:review-1"), { label: "renamed" })).toEqual({
      ok: false,
      reason: "Labels cannot be renamed.",
    });
  });

  test("cleans up an orphan reference without inventing a definition", () => {
    const doc = schema.topNodeType.create(null, [paragraph(reference("review-orphan"))]);
    const view = makeView(doc, NodeSelection.create(doc, 1));
    expect(removeTag(view, tag(view, "review:review-orphan"))).toEqual({ ok: true });
    expect(view.state.doc.textContent).toBe("");
    expect(view.state.doc.childCount).toBe(1);
  });

  test("updates a homogeneous link but refuses binary mark values", () => {
    const link = schema.marks.link.create({ href: "https://old.example", title: null });
    const doc = schema.topNodeType.create(null, [paragraph(text("link", [link]))]);
    const view = makeView(doc, TextSelection.create(doc, 2));
    expect(updateTag(view, tag(view, "mark:link"), { href: "https://new.example", title: "new" })).toEqual({ ok: true });
    expect(view.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe("https://new.example");
    expect(updateTag(view, tag(view, "mark:link"), { href: "https://newer.example" })).toEqual({ ok: true });
    const strong = schema.marks.strong.create();
    const strongDoc = schema.topNodeType.create(null, [paragraph(text("bold", [strong]))]);
    const strongView = makeView(strongDoc, TextSelection.create(strongDoc, 2));
    expect(updateTag(strongView, tag(strongView, "mark:strong"), "value").ok).toBe(false);
  });

  test("applies an inactive link after its URL is supplied", () => {
    const doc = schema.topNodeType.create(null, [paragraph(text("link"))]);
    const view = makeView(doc, TextSelection.create(doc, 1, 5));
    const descriptor = tag(view, "mark:link");
    expect(descriptor.state).toBe("off");
    expect(updateTag(view, descriptor, { href: "https://example.com", title: "Example" })).toEqual({ ok: true });
    expect(tag(view, "mark:link").state).toBe("on");
  });

  test("captures the whole homogeneous link run from a partial selection", () => {
    const link = schema.marks.link.create({ href: "https://old.example", title: null });
    const doc = schema.topNodeType.create(null, [paragraph(text("before "), text("linked", [link]), text(" after"))]);
    const view = makeView(doc, TextSelection.create(doc, 9, 11));
    const descriptor = tag(view, "mark:link");
    expect(descriptor.range).toEqual({ from: 8, to: 14 });
    expect(updateTag(view, descriptor, "https://new.example")).toEqual({ ok: true });
    expect(view.state.doc.firstChild?.child(1).marks[0]?.attrs.href).toBe("https://new.example");
    expect(view.state.doc.firstChild?.child(0).marks).toHaveLength(0);
  });

  test("changes heading level and removes a heading to a paragraph", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.heading.create({ level: 2 }, text("title")),
    ]);
    const view = makeView(doc, TextSelection.create(doc, 1));
    expect(updateTag(view, tag(view, "block:heading"), "heading-4")).toEqual({ ok: true });
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.firstChild?.attrs.level).toBe(4);
    expect(removeTag(view, tag(view, "block:heading"))).toEqual({ ok: true });
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});
