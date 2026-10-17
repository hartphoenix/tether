export class ChatStateError extends Error {}
/** Shared between the Tether service and the desktop adapter. */
export type Anchor = { messageId: string; text: string; start: number; end: number; prefix: string; suffix: string };
export type Draft = { id: string; quote: string; feedback: string; from?: "user" | "assistant"; code?: string | boolean; anchor?: Anchor; font?: string };
export type Submission = { id: string; prose: string; text: string; attachments: unknown[]; draftIds: string[]; messageId: string | null; wire: string | null; state: "prepared" | "dispatching" };
export type ChatState = { drafts: Draft[]; submission: Submission | null };
export type Operation = { kind: "read" } | { kind: "save"; draft: Draft } | { kind: "remove"; id: string } | { kind: "deleteChat" }
  | { kind: "capture"; id: string; prose: string; attachments: unknown[] }
  | { kind: "dispatch"; id: string; messageId: string; text: string; options: unknown }
  | { kind: "accepted"; id: string; messageId: string } | { kind: "cancelPrepared"; id: string };
export type ChatRequest = { generation?: string; host: string; agent: string; operation: Operation };
export function formatDrafts(drafts: Draft[]): string {
  return drafts.map(d => `<chat-selection${d.from ? ` from="${d.from}"` : ""}>\n  text: ${JSON.stringify(d.quote)}${d.code !== undefined ? `\n  code: ${JSON.stringify(d.code)}` : ""}\n  feedback: ${JSON.stringify(d.feedback)}\n</chat-selection>`).join("\n\n");
}
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const string = (x: unknown, max = 200_000): x is string => typeof x === "string" && x.length <= max;
const id = (x: unknown): x is string => string(x, 256) && x.length > 0;
/** Validate at the owning service boundary, independent of the plugin's RPC validator. */
export function parseChatRequest(value: unknown): ChatRequest {
  if (!record(value) || !id(value.host) || !id(value.agent) || !record(value.operation)) throw new ChatStateError("Invalid chat scope.");
  const o = value.operation;
  let valid = false;
  switch (o.kind) {
    case "read": case "deleteChat": valid = true; break;
    case "save": {
      const d = o.draft, a = d?.anchor;
      valid = record(d) && id(d.id) && string(d.quote) && !!d.quote && string(d.feedback)
        && (d.from === undefined || d.from === "user" || d.from === "assistant")
        && (d.code === undefined || typeof d.code === "boolean" || string(d.code, 128))
        && (d.font === undefined || string(d.font, 1000))
        && (a === undefined || record(a) && id(a.messageId) && string(a.text) && Number.isSafeInteger(a.start) && a.start >= 0 && Number.isSafeInteger(a.end) && a.end > a.start && string(a.prefix, 100) && string(a.suffix, 100));
      break;
    }
    case "capture": valid = id(o.id) && string(o.prose) && Array.isArray(o.attachments) && o.attachments.length <= 100; break;
    case "dispatch": valid = id(o.id) && id(o.messageId) && string(o.text) && record(o.options) && o.options.messageId === o.messageId; break;
    case "accepted": valid = id(o.id) && id(o.messageId); break;
    case "cancelPrepared": case "remove": valid = id(o.id); break;
  }
  if (!valid) throw new ChatStateError("Invalid chat operation.");
  return value as ChatRequest;
}
