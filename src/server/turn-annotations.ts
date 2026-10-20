import { formatDrafts } from "../../integrations/paseo/chat/model";
import type { ChatStore } from "../chat/store";

export type TurnAnnotations = {
  annotations?: string;
  text: string;
  dispatch(messageId: string, options?: { messageId: string; [key: string]: unknown }): void;
  accepted(messageId: string): void;
};

/** Uses the composer's formatter, capture lock, and acceptance deletion boundary. */
export function captureTurnAnnotations(store: ChatStore, scope: { host: string; agent: string } | undefined,
  signalId: string, event: string): TurnAnnotations {
  const empty = { text: event, dispatch() {}, accepted() {} };
  if (!scope) return empty;
  const current = store.operate({ ...scope, operation: { kind: "read" } });
  if (current.submission) throw new Error("A chat annotation batch is awaiting delivery. Recover or check acceptance in Paseo first.");
  if (!current.drafts.length) return empty;
  const captured = store.operate({ ...scope, operation: { kind: "capture", id: signalId, prose: "", attachments: [], suffix: event } });
  const submission = captured.submission!;
  return {
    annotations: formatDrafts(current.drafts), text: submission.text,
    dispatch(messageId, options = { messageId }) {
      store.operate({ ...scope, operation: { kind: "dispatch", id: signalId, messageId, text: submission.text, options } });
    },
    accepted(messageId) {
      store.operate({ ...scope, operation: { kind: "accepted", id: signalId, messageId } });
    },
  };
}
