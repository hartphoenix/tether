import { describe, expect, test } from "bun:test";
import { formatDrafts, type Draft } from "../integrations/paseo/chat/model";
import { parseSubmitted } from "../integrations/paseo/chat/submitted";

const drafts: Draft[] = [
  { id: "1", from: "assistant", quote: 'Quote with "escapes", \\ and\nnewlines <chat-selection> 😀', feedback: "Here is my response." },
  { id: "2", from: "user", quote: 'console.log("</chat-selection>")', code: "ts", feedback: "" },
  { id: "3", quote: "A passage", code: false, feedback: "<img src=x onerror=alert(1)>" },
];
describe("readable submitted annotations", () => {
  test("decodes wire text without losing prose, order, attribution, code or empty feedback", () => {
    const parts = parseSubmitted(`Before\n\n${formatDrafts(drafts)}\n\nAfter`)!;
    expect(parts.filter(p => p.kind === "annotation").map(p => p.draft)).toEqual(drafts.map(({ id, ...rest }) => rest));
    expect(parts[0]).toEqual({ kind: "prose", text: "Before\n\n" });
    expect(parts.at(-1)).toEqual({ kind: "prose", text: "\n\nAfter" });
  });
  test("handles CRLF and un-attributed legacy selections", () => {
    expect(parseSubmitted(formatDrafts([drafts[2]]).replaceAll("\n", "\r\n"))?.[0]).toEqual({ kind: "annotation", draft: { quote: drafts[2].quote, code: false, feedback: drafts[2].feedback } });
  });
  test.each([
    '<chat-selection from="system">\n  text: "quote"\n  feedback: "fine"\n</chat-selection>',
    '<chat-selection>\n  text: ""\n  feedback: "fine"\n</chat-selection>',
    '<chat-selection>\n  text: "quote"\n  feedback: null\n</chat-selection>',
    '<chat-selection>\n  text: "quote"\n  code: {}\n  feedback: ""\n</chat-selection>',
    '<chat-selection>\n  text: "quote"\n  surprise: "field"\n  feedback: ""\n</chat-selection>',
    '<chat-selection>\n  text: "quote"\n  feedback: ""',
    '<chat-selection>\n  text: "bad\\escape"\n  feedback: ""\n</chat-selection>',
    '</chat-selection>',
  ])("leaves the whole turn unchanged on malformed or unknown blocks: %s", malformed => {
    expect(parseSubmitted(`${formatDrafts([drafts[0]])}\n\n${malformed}`)).toBeNull();
  });
  test("does not format examples in fences or inline prose", () => {
    for (const fence of ["```", "~~~~"]) {
      const example = `${fence}text\n${formatDrafts(drafts)}\n${fence}`;
      expect(parseSubmitted(example)).toBeNull();
      const parts = parseSubmitted(`${example}\n\n${formatDrafts([drafts[0]])}`)!;
      expect(parts.filter(p => p.kind === "annotation")).toHaveLength(1);
      expect(parts[0]).toEqual({ kind: "prose", text: `${example}\n\n` });
    }
    expect(parseSubmitted('Discuss the <chat-selection> format.')).toBeNull();
  });
});
