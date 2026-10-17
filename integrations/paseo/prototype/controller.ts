import type { Operation, ProbeState } from "./contracts";
import type { NativeClient } from "./native";

export class ProbeController {
  state: ProbeState = { drafts: [], submission: null };
  fault: "none" | "before-send" | "after-acceptance" = "none";
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private rpc: (operation: Operation) => Promise<ProbeState>, private changed: () => void) {}
  run(operation: Operation): Promise<ProbeState> {
    const result = this.tail.then(async () => {
      this.state = await this.rpc(operation);
      this.changed();
      return this.state;
    });
    // A failed save must block capture until an explicit successful read/save.
    this.tail = result;
    return result;
  }
  async refresh() {
    await this.tail.catch(() => {});
    this.tail = Promise.resolve();
    return this.run({ kind: "read" });
  }
  async capture(prose: string, attachments: unknown[]) {
    return this.run({ kind: "capture", id: crypto.randomUUID(), prose, attachments });
  }
  async send(original: NativeClient["sendAgentMessage"], agent: string, text: string, options: Parameters<NativeClient["sendAgentMessage"]>[2]) {
    await this.tail;
    const pending = this.state.submission;
    if (!pending) throw new Error("Test chat is armed: use its ordinary composer with a saved test quote.");
    if (pending.state !== "prepared") throw new Error("Delivery uncertain. Reconcile before another send.");
    if (text !== pending.text) throw new Error("Queued or native text changed. Test send blocked; saved batch retained.");
    if (!options?.messageId) throw new Error("Native message ID unavailable. Send blocked.");
    if (this.fault === "before-send") {
      this.fault = "none";
      await this.run({ kind: "cancelPrepared", id: pending.id });
      throw new Error("Injected known failure before dispatch. Drafts retained; edit and send again.");
    }
    await this.run({ kind: "dispatch", id: pending.id, messageId: options.messageId, text, options });
    // Anything thrown from here is uncertain. Neither native errors nor composer clearing release drafts.
    await original(agent, text, options);
    if (this.fault === "after-acceptance") {
      this.fault = "none";
      throw new Error("Injected lost acceptance. Reconcile the saved message ID; do not resend.");
    }
    // Storage cleanup failure must not turn confirmed acceptance into a native retry.
    try { await this.run({ kind: "accepted", id: pending.id, messageId: options.messageId }); }
    catch { this.changed(); }
  }
  async reconcile(client: NativeClient, agent: string): Promise<boolean> {
    await this.refresh();
    const pending = this.state.submission;
    if (!pending?.messageId) return false;
    let cursor: unknown;
    for (let page = 0; page < 20; page++) {
      const result = await client.fetchAgentTimeline(agent, { projection: "canonical", limit: 100, ...(cursor ? { direction: "before", cursor } : { direction: "tail" }) });
      if (result.entries.some(entry => entry.item.type === "user_message" && entry.item.clientMessageId === pending.messageId)) {
        await this.run({ kind: "accepted", id: pending.id, messageId: pending.messageId });
        return true;
      }
      if (!result.hasOlder || !result.startCursor) break;
      cursor = result.startCursor;
    }
    return false; // Absence is not rejection, even after all currently available pages.
  }
}
