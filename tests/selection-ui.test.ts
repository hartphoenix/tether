import { expect, test } from "bun:test";
import { normalizeStyle } from "../src/web/selection-ui";

test("normalizes safe tag style declarations", () => {
  expect(normalizeStyle(" font-size: 1.2em; color: #e7e9ec ")).toEqual({
    css: "font-size: 1.2em; color: #e7e9ec;",
  });
});

test("rejects layout escape and URL-bearing tag styles", () => {
  expect(normalizeStyle("position: fixed").error).toContain("not an editable style property");
  expect(normalizeStyle("background-color: url(https://example.com/x)").error).toContain("Invalid value");
});
