import { expect, test } from "bun:test";
import { markdownTitle } from "../src/core/markdown-title";

test("selects the first highest-level rendered heading, ignoring metadata and code", () => {
  expect(markdownTitle('---\ntitle: Metadata\n---\n## Earlier\n```md\n# Code\n```\n# The *real* [title](https://example.com)\n# Later')).toBe("The real title");
  expect(markdownTitle("### Minor\nLiterary `title`\n----------------\n## Later")).toBe("Literary title");
  expect(markdownTitle("Plain text\n<!-- # Hidden -->")).toBeNull();
});
