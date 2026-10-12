import type { Submission } from "./model";
import type { QueueItem } from "./native";

// Paseo 0.11.2 carries chat_history attachments unchanged through native queue
// dispatch. This empty local carrier travels with the queue item, then is removed
// BEFORE the transport call. It never reaches the daemon/provider or saved wire.
// Text equality is a payload integrity check, never the batch's identity.
const prefix = "tether-annotation-batch:";
export function queuedBatch(p: Submission, host: string, agent: string): QueueItem {
  return { id: p.id, text: p.text, attachments: [...p.attachments, {
    kind: "chat_history", id: prefix + p.id, source: { serverId: host, agentId: agent },
    attachment: { type: "text", mimeType: "text/plain", text: "", contextKind: "chat_history", id: prefix + p.id },
  }] };
}
export function stripBatchCarrier(options: { messageId: string; [key: string]: unknown }): { id?: string; options: typeof options } {
  const attachments = options.attachments;
  if (!Array.isArray(attachments)) return { options };
  const carriers = attachments.filter(a => a?.type === "text" && a.text === "" && a.contextKind === "chat_history" && typeof a.id === "string" && a.id.startsWith(prefix));
  if (!carriers.length) return { options };
  if (carriers.length !== 1) throw new Error("Ambiguous queued annotation identity; send blocked.");
  const id = carriers[0].id.slice(prefix.length);
  // Paseo's optimistic message shares this freshly converted array. Remove our
  // carrier there too, so an empty bookkeeping attachment cannot remain visible.
  attachments.splice(attachments.indexOf(carriers[0]), 1);
  return { id, options };
}
