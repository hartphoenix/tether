import { expect, test } from "bun:test";
import { parseTurnMessage } from "../integrations/paseo/shared/turn-message";
test("the chat chip preserves staged annotations and decodes only its final document pointer", () => {
  expect(parseTurnMessage('Feedback\n\n<tether-turn path="/a &amp; b.md" document-id="doc" signal-id="signal" />'))
    .toEqual({ annotations: "Feedback", path: "/a & b.md", documentId: "doc", signalId: "signal" });
  expect(parseTurnMessage('<tether-turn path="/a.md" />')).toEqual({ annotations: "", path: "/a.md" });
  expect(parseTurnMessage('Please explain <tether-turn path="/a.md" /> syntax')).toBeUndefined();
});
