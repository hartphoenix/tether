import { expect, test } from "bun:test";
import { Schema, type Node } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { decreaseQuoteLevel } from "../src/web/editor-commands";

const schema = new Schema({ nodes: {
  doc: { content: "block+" },
  paragraph: { content: "text*", group: "block" },
  blockquote: { content: "block+", group: "block" },
  bullet_list: { content: "list_item+", group: "block" },
  list_item: { content: "paragraph block*" },
  text: {},
} });
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const quote = (...children: Node[]) => schema.nodes.blockquote.create(null, children);
function decrease(children: Node[], from: number, to = from) {
  const doc = schema.nodes.doc.create(null, children);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  const applied = decreaseQuoteLevel(state, tr => { state = state.apply(tr); });
  return { applied, doc: state.doc };
}

test("decrease removes only the innermost quote level", () => {
  expect(decrease([quote(quote(p("a")))], 3).doc.eq(schema.nodes.doc.create(null, quote(p("a"))))).toBe(true);
});

test("decrease lifts selected paragraphs and preserves surrounding quotes", () => {
  expect(decrease([quote(p("a"), p("b"), p("c"), p("d"))], 5, 9).doc.eq(
    schema.nodes.doc.create(null, [quote(p("a")), p("b"), p("c"), quote(p("d"))]),
  )).toBe(true);
});

test("decrease preserves a list inside a quote and does nothing outside quotes", () => {
  const list = schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null, p("a")));
  expect(decrease([quote(list)], 4).doc.eq(schema.nodes.doc.create(null, list))).toBe(true);
  const outside = decrease([list], 3);
  expect(outside.applied).toBe(false);
  expect(outside.doc.eq(schema.nodes.doc.create(null, list))).toBe(true);
});
