import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateStore } from "../src/storage/private-store";
import { PrototypeStore } from "../src/chat/prototype-store";
import { ProbeController } from "../integrations/paseo/prototype/controller";
import type { Operation } from "../integrations/paseo/prototype/contracts";

const draft = (id: string) => ({ id, quote: `quote ${id}`, feedback: "" });
function apply(store: PrototypeStore, scope: string, op: Operation) {
  switch (op.kind) {
    case "read": return store.read(scope);
    case "save": return store.save(scope, op.draft);
    case "capture": return store.capture(scope, op.id, op.prose, op.attachments);
    case "dispatch": return store.dispatch(scope, op.id, op.messageId, op.text, op.options);
    case "accepted": return store.accepted(scope, op.id, op.messageId);
    case "cancelPrepared": return store.cancelPrepared(scope, op.id);
  }
}
describe("Paseo delivery prototype", () => {
  test("service owns the database across separate stdin/stdout requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tether-chat-service-"));
    const path = join(directory, "delivery-prototype.sqlite");
    const request = async (operation: Operation) => {
      const process = Bun.spawn([Bun.which("bun")!, "scripts/paseo-delivery-service.ts", path], { stdin: new Blob([JSON.stringify({ host: "fixture-host", agent: "fixture-chat", operation })]), stdout: "pipe", stderr: "pipe" });
      const result = JSON.parse(await new Response(process.stdout).text());
      expect(await process.exited).toBe(0); expect(result.ok).toBe(true);
      return result.data;
    };
    try {
      await request({ kind: "save", draft: draft("service-draft") });
      const captured = await request({ kind: "capture", id: "service-batch", prose: "fixture", attachments: [] });
      await request({ kind: "dispatch", id: "service-batch", messageId: "service-message", text: captured.submission.text, options: { messageId: "service-message" } });
      expect((await request({ kind: "read" })).submission.messageId).toBe("service-message");
      expect(await request({ kind: "accepted", id: "service-batch", messageId: "service-message" })).toEqual({ drafts: [], submission: null });
    } finally { rmSync(directory, { recursive: true }); }
  });
  test("durable ordered capture, host/chat isolation, empty feedback and transactional cleanup after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "tether-chat-probe-"));
    const path = join(directory, "state.sqlite");
    let owner = new PrivateStore(path);
    try {
      let store = new PrototypeStore(owner.db);
      store.save("host-a/chat", draft("1")); store.save("host-a/chat", draft("2"));
      store.save("host-b/chat", draft("1"));
      store.save("host-a/chat", { ...draft("1"), feedback: "edited" });
      const state = store.capture("host-a/chat", "batch", "prose", [{ kind: "file", attachment: { id: "file" } }]);
      expect(state.submission!.draftIds).toEqual(["1", "2"]);
      store.dispatch("host-a/chat", "batch", "native-id", state.submission!.text, { images: [], activeTurnBehavior: "steer" });
      store.save("host-a/chat", draft("3"));
      owner.close(); owner = new PrivateStore(path); store = new PrototypeStore(owner.db);
      expect(store.read("host-a/chat").submission!.messageId).toBe("native-id");
      expect(() => store.dispatch("host-a/chat", "batch", "new-id", state.submission!.text, {})).toThrow("uncertain");
      store.accepted("host-a/chat", "batch", "native-id");
      expect(store.read("host-a/chat")).toEqual({ drafts: [draft("3")], submission: null });
      expect(store.read("host-b/chat").drafts).toEqual([draft("1")]);
      expect(owner.db.query("SELECT count(*) AS count FROM chat_probe_submissions").get()).toEqual({ count: 0 });
    } finally { owner.close(); rmSync(directory, { recursive: true }); }
  });
  test("save immediately followed by capture waits for persistence; failed save blocks send", async () => {
    const owner = new PrivateStore(); const store = new PrototypeStore(owner.db);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const controller = new ProbeController(async op => { if (op.kind === "save") await barrier; return apply(store, "chat", op); }, () => {});
    const save = controller.run({ kind: "save", draft: draft("1") });
    const capture = controller.capture("prose", []);
    expect(store.read("chat").submission).toBeNull(); release(); await save; await capture;
    expect(controller.state.submission!.draftIds).toEqual(["1"]);
    const failed = new ProbeController(async () => { throw new Error("disk failure"); }, () => {});
    await expect(failed.run({ kind: "save", draft: draft("1") })).rejects.toThrow("disk failure");
    await expect(failed.capture("prose", [])).rejects.toThrow("disk failure");
    owner.close();
  });
  test("native options survive; acceptance cleans only captured drafts; ambiguity blocks retry and reconciles by ID", async () => {
    const owner = new PrivateStore(); const store = new PrototypeStore(owner.db);
    const controller = new ProbeController(async op => apply(store, "chat", op), () => {});
    await controller.run({ kind: "save", draft: draft("1") }); await controller.capture("hi", []);
    controller.fault = "after-acceptance";
    const payload = controller.state.submission!.text;
    const options = { messageId: "native", activeTurnBehavior: "interrupt", images: [{ data: "fixture", mimeType: "image/png" }], attachments: [{ id: "file" }] };
    let sent = 0;
    const send = async (_agent: string, text: string, received: unknown) => { sent++; expect(text).toBe(payload); expect(received).toBe(options); expect(store.read("chat").submission!.messageId).toBe("native"); };
    await expect(controller.send(send, "chat", payload, options)).rejects.toThrow("lost acceptance");
    await controller.run({ kind: "save", draft: draft("later") });
    await expect(controller.send(send, "chat", payload, options)).rejects.toThrow("uncertain");
    expect(sent).toBe(1);
    expect(await controller.reconcile({ sendAgentMessage: send, fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", clientMessageId: "other" } }], hasOlder: false, startCursor: null }) }, "chat")).toBe(false);
    expect(await controller.reconcile({ sendAgentMessage: send, fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", clientMessageId: "native" } }], hasOlder: false, startCursor: null }) }, "chat")).toBe(true);
    expect(controller.state).toEqual({ drafts: [draft("later")], submission: null }); owner.close();
  });
  test("known pre-dispatch failure retains editable drafts without calling transport", async () => {
    const owner = new PrivateStore(); const store = new PrototypeStore(owner.db);
    const controller = new ProbeController(async op => apply(store, "chat", op), () => {});
    await controller.run({ kind: "save", draft: draft("1") }); await controller.capture("hi", []);
    controller.fault = "before-send";
    await expect(controller.send(async () => { throw new Error("must not send"); }, "chat", controller.state.submission!.text, { messageId: "id" })).rejects.toThrow("known failure");
    expect(controller.state.submission).toBeNull();
    await controller.run({ kind: "save", draft: { ...draft("1"), feedback: "editable" } }); owner.close();
  });
});
