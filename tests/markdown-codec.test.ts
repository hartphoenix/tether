import { expect, test } from "bun:test";
import { prepareMarkdown, restoreMarkdown, wikilinkRoute } from "../src/core/markdown-codec";

test("preserves frontmatter while preparing and restoring wikilinks", () => {
  const source = "---\ntitle: Example\n---\n\nSee [[design/plan|Plan]].\n";
  const prepared = prepareMarkdown(source);

  expect(prepared.frontmatter).toBe("---\ntitle: Example\n---\n");
  expect(prepared.editorMarkdown).toBe(`\nSee [Plan](${wikilinkRoute}design%2Fplan%7CPlan).\n`);
  expect(restoreMarkdown(prepared.editorMarkdown, prepared.frontmatter)).toBe(source);
});

test("restores links prepared by the legacy Wave viewer", () => {
  const prepared = "See [Plan](/_wave-markdown/wikilink/design%2Fplan%7CPlan).";
  expect(restoreMarkdown(prepared, "")).toBe("See [[design/plan|Plan]].");
});
