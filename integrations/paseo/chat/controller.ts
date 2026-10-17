import type { ChatState, Operation } from "./model";
import type { NativeClient } from "./native";

export class ChatController {
  state: ChatState = { drafts: [], submission: null };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private rpc: (operation: Operation) => Promise<ChatState>, private changed: () => void) {}
  run(operation: Operation): Promise<ChatState> {
    const result = this.tail.then(async () => { this.state = await this.rpc(operation); this.changed(); return this.state; });
    this.tail = result;
    return result;
  }
  async refresh() {
    this.tail = this.tail.catch(() => {});
    return this.run({ kind: "read" });
  }
  async save(draft: ChatState["drafts"][number]) {
    // A deliberate retry may recover a failed save; capture itself never bypasses failure.
    this.tail = this.tail.catch(() => {});
    return this.run({ kind: "save", draft });
  }
  async capture(prose: string, attachments: unknown[]) {
    return this.run({ kind: "capture", id: crypto.randomUUID(), prose, attachments });
  }
  async send(original: NativeClient["sendAgentMessage"], agent: string, text: string, options: Parameters<NativeClient["sendAgentMessage"]>[2], batchId?: string) {
    await this.tail;
    if (!batchId) return original(agent, text, options);
    const pending = this.state.submission;
    if (!pending || pending.id !== batchId) throw new Error("Annotation batch identity unavailable. Refresh before retrying.");
    if (pending.state !== "prepared") throw new Error("Delivery uncertain. Check acceptance before another send.");
    if (pending.text !== text) throw new Error("Queued annotation text changed; recover the batch for editing.");
    await this.run({ kind: "dispatch", id: pending.id, messageId: options.messageId, text, options });
    await original(agent, text, options);
    // Once accepted, cleanup failure must never make Paseo offer a transport retry.
    try { await this.run({ kind: "accepted", id: pending.id, messageId: options.messageId }); }
    catch { this.changed(); }
  }
  async reconcile(receipt: () => Promise<{ accepted: boolean; state: ChatState }>, client: NativeClient, agent: string) {
    await this.refresh();
    // Reconciliation and saves share one serial boundary. A receipt response
    // must not overwrite a newer successful save in the visible client state.
    const result = this.tail.then(async () => {
      const pending = this.state.submission;
      if (!pending?.messageId) return false;
      const proof = await receipt();
      if (proof.accepted) { this.state = proof.state; this.changed(); return true; }
      let cursor: unknown;
      for (let page = 0; page < 20; page++) {
        const pageResult = await client.fetchAgentTimeline(agent, { projection: "canonical", limit: 100, ...(cursor ? { direction: "before", cursor } : { direction: "tail" }) });
        if (pageResult.entries.some(e => e.item.type === "user_message" && e.item.clientMessageId === pending.messageId)) {
          this.state = await this.rpc({ kind: "accepted", id: pending.id, messageId: pending.messageId });
          this.changed(); return true;
        }
        if (!pageResult.hasOlder || !pageResult.startCursor) break;
        cursor = pageResult.startCursor;
      }
      return false;
    });
    this.tail = result;
    return result;
  }
}
