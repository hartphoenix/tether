import { expect, test } from "bun:test";
import { documentLinkPath, localDocumentLink, opensAsDocument } from "../src/web/local-document-link";

test("routes authored local paths without resolving against the browser session", () => {
  const target = "../data/transcriptions/c6468e2f79a913f8fb55/transcript.txt";
  expect(localDocumentLink(target)).toEqual({ target, format: "markdown" });
  expect(localDocumentLink("/_tether/wikilink/..%2Fnotes.md%7CNotes")).toEqual({ target: "../notes.md|Notes", format: "wikilink" });
  expect(localDocumentLink("/tmp/my%20file.txt")).toEqual({ target: "/tmp/my%20file.txt", format: "markdown" });
});

test("leaves external URLs and same-document anchors to the browser", () => {
  for (const href of ["", "#heading", "https://example.com/a", "//example.com/a", "mailto:a@example.com", "file:///tmp/a", "https://example.com/_tether/wikilink/a"]) {
    expect(localDocumentLink(href)).toBeNull();
  }
});

test("only Markdown documents open as reader tabs from the page", () => {
  expect(opensAsDocument({ target: "notes", format: "wikilink" })).toBe(true);
  expect(opensAsDocument({ target: "../notes.md|Notes", format: "wikilink" })).toBe(true);
  expect(opensAsDocument({ target: "notes#Section", format: "wikilink" })).toBe(true);
  expect(opensAsDocument({ target: "diagram.png", format: "wikilink" })).toBe(false);
  expect(opensAsDocument({ target: "../docs/Plan.MARKDOWN#top", format: "markdown" })).toBe(true);
  expect(opensAsDocument({ target: "data/transcript.txt", format: "markdown" })).toBe(false);
  expect(opensAsDocument({ target: "folder/README", format: "markdown" })).toBe(false);
  expect(documentLinkPath({ target: "a b|c", format: "wikilink" })).toBe("api/link?target=a%20b%7Cc&format=wikilink");
});
