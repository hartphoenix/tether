import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrivateStore } from "../src/storage/private-store";
import { ChatStore } from "../src/chat/store";
import { ChatController } from "../integrations/paseo/chat/controller";
import { hasCompletedReceipt, receiptDigest, receiptRequest } from "../integrations/paseo/chat/receipts";
import { queuedBatch, stripBatchCarrier } from "../integrations/paseo/chat/queue";
import { parseChatRequest, type Operation } from "../integrations/paseo/chat/model";
const draft = (id: string) => ({ id, quote: `quote ${id}`, feedback: "" });
const scope = '["host","agent"]';
function fixture() {
  const owner = new PrivateStore(), store = new ChatStore(owner.db);
  const run = (operation: Operation, host = "host", agent = "agent") => store.operate({ host, agent, operation });
  return { owner, store, run };
}
describe("Paseo chat annotations", () => {
  test("ordered immutable capture, empty feedback, isolation, new edits and payload cleanup", () => {
    const { owner, store, run } = fixture();
    try {
      run({ kind: "save", draft: draft("1") }); run({ kind: "save", draft: draft("2") });
      run({ kind: "save", draft: draft("1") }, "other-host");
      run({ kind: "save", draft: { ...draft("1"), feedback: "edited", from: "assistant", code: "ts" } });
      const pending = run({ kind: "capture", id: "batch", prose: "hello", attachments: [] }).submission!;
      expect(pending.draftIds).toEqual(["1", "2"]);
      expect(pending.text).toContain('from="assistant"'); expect(pending.text).toContain('feedback: ""'); expect(pending.text).not.toContain('batch');
      expect(() => run({ kind: "remove", id: "1" })).toThrow("awaiting delivery");
      run({ kind: "dispatch", id: pending.id, messageId: "native", text: pending.text, options: { messageId: "native" } });
      expect(() => run({ kind: "cancelPrepared", id: pending.id })).toThrow("uncertain");
      run({ kind: "save", draft: draft("later") });
      run({ kind: "accepted", id: pending.id, messageId: "native" });
      expect(store.read(scope)).toEqual({ drafts: [draft("later")], submission: null });
      expect(store.read('["other-host","agent"]').drafts).toHaveLength(1);
      expect(owner.db.query("SELECT count(*) AS n FROM chat_submissions").get()).toEqual({ n: 0 });
      run({ kind: "deleteChat" }); expect(store.read(scope).drafts).toHaveLength(0);
    } finally { owner.close(); }
  });
  test("save immediately followed by capture waits; save failure blocks capture until deliberate retry", async () => {
    const { owner, run } = fixture();
    let release!: () => void, fail = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const c = new ChatController(async op => { if (op.kind === "save") { await barrier; if (fail) throw Error("disk full"); } return run(op); }, () => {});
    try {
      const save = c.save(draft("1")), capture = c.capture("", []); release(); await save; await capture;
      expect(c.state.submission?.draftIds).toEqual(["1"]);
      await c.run({ kind: "cancelPrepared", id: c.state.submission!.id });
      fail = true; await expect(c.save(draft("2"))).rejects.toThrow("disk full");
      await expect(c.capture("", [])).rejects.toThrow("disk full");
      fail = false; await c.save(draft("2")); await c.capture("", []);
      expect(c.state.submission?.draftIds).toEqual(["1", "2"]);
    } finally { owner.close(); }
  });
  test("ordinary sends pass through; only identified annotation sends enter durable dispatch", async () => {
    const { owner, run } = fixture(); const c = new ChatController(async op => run(op), () => {});
    const sends: unknown[] = [], options = { messageId: "native", images: [{ data: "fixture", mimeType: "image/png" }], activeTurnBehavior: "steer" };
    const send = async (_agent: string, text: string, wire: unknown) => { sends.push({ text, wire }); };
    try {
      await c.send(send, "agent", "ordinary", options); expect(sends).toHaveLength(1);
      await c.save(draft("1")); await c.capture("", []); const pending = c.state.submission!;
      await expect(c.send(send, "agent", "changed", options, pending.id)).rejects.toThrow("changed");
      await c.send(send, "agent", pending.text, options, pending.id);
      expect((sends[1] as any).wire).toBe(options); expect(c.state).toEqual({ drafts: [], submission: null });
    } finally { owner.close(); }
  });
  test("lost acceptance remains uncertain and cannot automatically resend", async () => {
    const { owner, run } = fixture(); const c = new ChatController(async op => run(op), () => {}); let sends = 0;
    try {
      await c.save(draft("1")); await c.capture("", []); const p = c.state.submission!;
      const send = async () => { sends++; throw Error("lost response"); };
      await expect(c.send(send, "agent", p.text, { messageId: "native" }, p.id)).rejects.toThrow("lost response");
      await expect(c.send(send, "agent", p.text, { messageId: "new" }, p.id)).rejects.toThrow("uncertain");
      expect(sends).toBe(1); expect(c.state.submission?.messageId).toBe("native");
    } finally { owner.close(); }
  });
  test("completed receipt proves matching payload after reopen even when timeline loses client IDs", async () => {
    const home = await mkdtemp("/tmp/tether-chat-receipts-"); const path = join(home, "tether.sqlite"); let owner = new PrivateStore(path);
    try {
      let store = new ChatStore(owner.db);
      const run = (operation: Operation) => store.operate({ host: "host", agent: "agent", operation });
      run({ kind: "save", draft: draft("1") }); const p = run({ kind: "capture", id: "batch", prose: "", attachments: [] }).submission!;
      const options = { messageId: "native", activeTurnBehavior: "steer", images: [{ data: "base64", mimeType: "image/png" }], attachments: [{ type: "text", contextKind: "chat_history", text: "history", mimeType: "text/plain" }, { type: "uploaded_file", path: "/fixture" }] };
      run({ kind: "dispatch", id: p.id, messageId: "native", text: p.text, options });
      owner.close(); owner = new PrivateStore(path); store = new ChatStore(owner.db);
      await writeFile(join(home, "server-id"), "host\n"); await mkdir(join(home, "agent-requests"));
      const file = join(home, "agent-requests", `${receiptDigest(["send", "agent", "native"])}.json`);
      const fingerprint = receiptDigest({ activeTurnBehavior: "steer", prompt: [options.attachments[0], { type: "text", text: p.text }, { type: "image", data: "base64", mimeType: "image/png" }, options.attachments[1]] });
      const restored = store.read(scope).submission!;
      expect(receiptRequest(restored.wire!)).toEqual({ activeTurnBehavior: "steer", prompt: [options.attachments[0], { type: "text", text: p.text }, { type: "image", data: "base64", mimeType: "image/png" }, options.attachments[1]] });
      await writeFile(file, JSON.stringify({ agentId: "agent", fingerprint, state: "pending" }));
      expect(await hasCompletedReceipt(home, "host", "agent", restored)).toBe(false);
      await writeFile(file, JSON.stringify({ agentId: "agent", fingerprint, state: "completed" }));
      expect(await hasCompletedReceipt(home, "wrong-host", "agent", restored)).toBe(false);
      expect(await hasCompletedReceipt(home, "host", "agent", { ...restored, wire: restored.wire!.replace("base64", "different") })).toBe(false);
      const c = new ChatController(async op => run(op), () => {});
      let timelineReads = 0;
      expect(await c.reconcile(async () => ({ accepted: await hasCompletedReceipt(home, "host", "agent", restored), state: run({ kind: "accepted", id: restored.id, messageId: restored.messageId! }) }), { sendAgentMessage: async () => {}, fetchAgentTimeline: async () => { timelineReads++; return { entries: [], hasOlder: false, startCursor: null }; } }, "agent")).toBe(true);
      expect(timelineReads).toBe(0); expect(c.state.drafts).toHaveLength(0);
    } finally { owner.close(); await rm(home, { recursive: true }); }
  });
  test("a save during receipt reconciliation remains visible after the receipt returns", async () => {
    const { owner, run } = fixture();
    const c = new ChatController(async op => run(op), () => {});
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await c.save(draft("first")); await c.capture("", []); const p = c.state.submission!;
      await c.run({ kind: "dispatch", id: p.id, messageId: "native", text: p.text, options: { messageId: "native" } });
      const reconcile = c.reconcile(async () => {
        const state = run({ kind: "accepted", id: p.id, messageId: "native" }); entered(); await barrier;
        return { accepted: true, state };
      }, { sendAgentMessage: async () => {}, fetchAgentTimeline: async () => { throw Error("Receipt should suffice"); } }, "agent");
      await started; const save = c.save(draft("newer")); release();
      await reconcile; await save;
      expect(c.state.drafts).toEqual([draft("newer")]);
    } finally { owner.close(); }
  });
  test("queue identity survives JSON/restart and is stripped without changing real attachments", () => {
    const { owner, run } = fixture();
    try {
      run({ kind: "save", draft: draft("1") }); const p = run({ kind: "capture", id: "batch", prose: "", attachments: [{ kind: "file", attachment: { type: "uploaded_file", id: "file" } }] }).submission!;
      const row = JSON.parse(JSON.stringify(queuedBatch(p, "host", "agent")));
      // These branches mirror Paseo's file and chat_history submit conversion;
      // the pinned-source harness separately executes its actual implementation.
      const wire = { messageId: "native", images: [], activeTurnBehavior: "steer", attachments: row.attachments.map((a: any) => a.attachment) };
      const stripped = stripBatchCarrier(wire);
      expect(stripped.id).toBe(p.id); expect(stripped.options.attachments).toEqual([{ type: "uploaded_file", id: "file" }]);
      expect(stripped.options.images).toBe(wire.images); expect(JSON.stringify(stripped.options)).not.toContain("tether-annotation-batch");
    } finally { owner.close(); }
  });
  test("service validation rejects invalid scopes and malformed anchors", () => {
    expect(() => parseChatRequest({ host: "", agent: "a", operation: { kind: "deleteChat" } })).toThrow();
    expect(() => parseChatRequest({ host: "h", agent: "a", operation: { kind: "save", draft: { ...draft("1"), anchor: { start: -1 } } } })).toThrow();
  });
});
