import type { Draft } from "./model";

export type SubmittedPart = { kind: "prose"; text: string } | { kind: "annotation"; draft: Omit<Draft, "id"> };

/** Recognize the wire format we emit. Never partially format a malformed turn. */
export function parseSubmitted(text: string): SubmittedPart[] | null {
  if (!text.includes("<chat-selection")) return null;
  const lines = text.split("\n"), parts: SubmittedPart[] = [];
  let offset = 0, proseStart = 0, count = 0, fence: { mark: string; length: number } | undefined;
  const line = (index: number) => lines[index]?.replace(/\r$/, "");
  const field = (index: number, name: string): unknown => {
    const value = line(index), prefix = `  ${name}: `;
    if (!value?.startsWith(prefix)) throw new Error("Unknown annotation field");
    return JSON.parse(value.slice(prefix.length));
  };
  for (let i = 0; i < lines.length; i++) {
    const current = line(i)!;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(current);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.mark && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
    } else if (delimiter) {
      fence = { mark: delimiter[1][0], length: delimiter[1].length };
    } else if (/^\s*<\/?chat-selection\b/.test(current)) {
      const header = /^<chat-selection(?: from="(user|assistant)")?>$/.exec(current);
      if (!header) return null;
      try {
        const quote = field(i + 1, "text");
        let end = i + 2, code: Draft["code"];
        if (line(end)?.startsWith("  code: ")) {
          const value = field(end++, "code");
          if (typeof value !== "boolean" && typeof value !== "string") return null;
          code = value;
        }
        const feedback = field(end++, "feedback");
        if (typeof quote !== "string" || !quote || typeof feedback !== "string" || line(end) !== "</chat-selection>") return null;
        if (offset > proseStart) parts.push({ kind: "prose", text: text.slice(proseStart, offset) });
        parts.push({ kind: "annotation", draft: { quote, feedback, ...(header[1] ? { from: header[1] as Draft["from"] } : {}), ...(code !== undefined ? { code } : {}) } });
        count++;
        for (; i < end; i++) offset += lines[i].length + 1;
        proseStart = offset + lines[i].length; // Leave the closing line's newline in the following prose.
      } catch { return null; }
    }
    offset += lines[i].length + 1;
  }
  if (!count) return null;
  if (proseStart < text.length) parts.push({ kind: "prose", text: text.slice(proseStart) });
  return parts;
}
