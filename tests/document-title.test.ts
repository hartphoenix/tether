import { expect, test } from "bun:test";
import { Schema } from "@milkdown/kit/prose/model";
import { documentTabTitle, filenameStem } from "../src/web/document-title";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
  },
});

const text = (value: string) => schema.text(value);
const heading = (level: number, value = "") => schema.nodes.heading.create({ level }, value ? text(value) : undefined);

test("uses the first non-empty H1 as the document tab title", () => {
  const doc = schema.nodes.doc.create(null, [heading(2, "Introduction"), heading(1), heading(1, "  Primary   title  "), heading(1, "Later")]);
  expect(documentTabTitle("/tmp/fallback-name.md", doc)).toBe("Primary title");
});

test("falls back to the Markdown filename stem when there is no non-empty H1", () => {
  const doc = schema.nodes.doc.create(null, [heading(2, "Section"), schema.nodes.paragraph.create(null, text("Body"))]);
  expect(documentTabTitle("/tmp/review.markdown", doc)).toBe("review");
  expect(filenameStem("/tmp/UPPER.MD")).toBe("UPPER");
});
