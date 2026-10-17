import { chromium } from "playwright";
import assert from "node:assert/strict";
import { PrivateStore } from "../src/storage/private-store";
import { PrototypeStore } from "../src/chat/prototype-store";
import { probeRpc } from "../integrations/paseo/prototype/contracts";

const build = await Bun.build({ entrypoints: ["integrations/paseo/prototype/index.client.ts"], target: "browser" });
if (!build.success) throw new Error(build.logs.join("\n"));
const source = await build.outputs[0].text();
const owner = new PrivateStore();
const store = new PrototypeStore(owner.db);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("http://localhost/probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("http://localhost/probe");
  await page.exposeFunction("probeRpc", async (raw: unknown) => {
    const input = probeRpc.input.parse(raw), op = input.operation, scope = JSON.stringify([input.host, input.agent]);
    if (op.kind === "save") await new Promise(resolve => setTimeout(resolve, 60));
    return op.kind === "read" ? store.read(scope)
      : op.kind === "save" ? store.save(scope, op.draft)
      : op.kind === "capture" ? store.capture(scope, op.id, op.prose, op.attachments)
      : op.kind === "dispatch" ? store.dispatch(scope, op.id, op.messageId, op.text, op.options)
      : op.kind === "accepted" ? store.accepted(scope, op.id, op.messageId)
      : store.cancelPrepared(scope, op.id);
  });
  await page.setContent('<section id="a"><div data-testid="message-input-root"><textarea data-composer-input></textarea><button aria-label="Send">Send</button></div></section><section id="b"><div data-testid="message-input-root"><textarea data-composer-input></textarea><button aria-label="Send">Send</button></div></section>');
  await page.evaluate(async source => {
    const state = window as unknown as Record<string, any>;
    state.paseoDesktop = {}; state.sent = []; state.queues = new Map(); state.nativeProps = {};
    const native = {
      async sendAgentMessage(agent: string, text: string, options: unknown) { state.sent.push({ agent, text, options }); },
      async fetchAgentTimeline() { return { entries: state.sent.map((s: any) => ({ item: { type: "user_message", clientMessageId: s.options.messageId } })), hasOlder: false, startCursor: null }; },
    };
    state.native = native;
    state.originalSend = native.sendAgentMessage;
    for (const agent of ["a", "b"]) {
      const input = document.querySelector<HTMLTextAreaElement>(`#${agent} textarea`)!;
      const button = document.querySelector<HTMLButtonElement>(`#${agent} button`)!;
      const queue = { read: (id: string) => state.queues.get(id) ?? [], write: (update: (value: unknown) => unknown) => { state.queues = update(state.queues); } };
      const props = { voiceServerId: "host", voiceAgentId: agent, client: native, attachments: [{ kind: "file", attachment: { id: "fixture-file" } }], onSubmit: () => {}, defaultSendBehavior: "steer", isAgentRunning: false };
      state.nativeProps[agent] = props;
      Reflect.set(input, "__reactFiber$test", { memoizedProps: props, memoizedState: { memoizedState: [queue, []] } });
      Reflect.set(button, "__reactFiber$test", { memoizedProps: { onDefaultSendAction: () => {}, submitAccessibilityLabel: "Send", shouldShow: true } });
      const send = async () => {
        const text = input.value.trim(); if (!text) return;
        input.value = "";
        if (props.isAgentRunning && props.defaultSendBehavior === "queue") { state.queues.set(agent, [{ id: "queue-id", text, attachments: props.attachments }]); return; }
        try { await native.sendAgentMessage(agent, text, { messageId: crypto.randomUUID(), activeTurnBehavior: props.defaultSendBehavior, attachments: props.attachments }); }
        catch { input.value = text; }
      };
      input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.defaultPrevented) { event.preventDefault(); void send(); } });
      button.addEventListener("click", () => { void send(); });
    }
    const module = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    state.startProbe = () => module.default({ rpc: (_contract: unknown, input: unknown) => state.probeRpc(input) });
    state.stopProbe = state.startProbe();
  }, source);
  for (const agent of ["a", "b"]) {
    await page.locator(`#${agent} summary`).click();
    await page.locator(`#${agent}`).getByRole("button", { name: "Arm this disposable chat", exact: true }).click();
    await page.locator(`#${agent} [aria-live]`).filter({ hasText: "ready" }).waitFor();
    await page.locator(`#${agent}`).getByRole("textbox", { name: "Test quote", exact: true }).fill(`quote-${agent}`);
    await page.locator(`#${agent}`).getByRole("button", { name: "Save quote", exact: true }).click();
  }
  await page.locator("#a textarea[data-composer-input]").fill("prose");
  await page.locator("#a textarea[data-composer-input]").press("Enter");
  await page.waitForFunction(() => (window as any).sent.length === 1);
  await page.locator("#a [aria-live]").filter({ hasText: "0 saved · ready" }).waitFor();
  let sent = await page.evaluate(() => (window as any).sent);
  assert.match(sent[0].text, /quote-a/); assert.doesNotMatch(sent[0].text, /quote-b/);
  assert.equal(sent[0].options.attachments[0].attachment.id, "fixture-file");
  await page.locator("#b [aria-live]").filter({ hasText: "1 saved · ready" }).waitFor();
  assert.equal(store.read('["host","b"]').drafts.length, 1);
  await page.locator("#b").getByRole("button", { name: "Lose next acceptance", exact: true }).click();
  await page.locator("#b textarea[data-composer-input]").fill("uncertain");
  await page.locator('#b button[aria-label="Send"]').click();
  await page.waitForFunction(() => (window as any).sent.length === 2);
  await page.locator("#b [aria-live]").filter({ hasText: "lost acceptance" }).waitFor();
  await page.locator("#b textarea[data-composer-input]").press("Enter");
  assert.equal(await page.evaluate(() => (window as any).sent.length), 2);
  // Simulate plugin reload: discard all plugin memory, retain the service and daemon timeline.
  await page.evaluate(() => { const state = window as any; state.stopProbe(); state.stopProbe = state.startProbe(); });
  await page.locator("#b summary").click();
  await page.locator("#b").getByRole("button", { name: "Arm this disposable chat", exact: true }).click();
  await page.locator("#b [aria-live]").filter({ hasText: "dispatching" }).waitFor();
  await page.locator("#b").getByRole("button", { name: "Reconcile acceptance", exact: true }).click();
  await page.locator("#b [aria-live]").filter({ hasText: "Acceptance confirmed" }).waitFor();
  assert.equal(store.read('["host","b"]').submission, null);
  await page.locator("#a summary").click();
  await page.locator("#a").getByRole("button", { name: "Arm this disposable chat", exact: true }).click();
  await page.locator("#a [aria-live]").filter({ hasText: "ready" }).waitFor();
  await page.locator("#a").getByRole("button", { name: "New quote", exact: true }).click();
  await page.locator("#a").getByRole("textbox", { name: "Test quote", exact: true }).fill("queued quote");
  await page.locator("#a").getByRole("button", { name: "Save quote", exact: true }).click();
  await page.evaluate(() => { (window as any).nativeProps.a.isAgentRunning = true; (window as any).nativeProps.a.defaultSendBehavior = "queue"; });
  await page.locator("#a textarea[data-composer-input]").fill("queued prose");
  await page.locator("#a textarea[data-composer-input]").press("Enter");
  await page.waitForFunction(() => (window as any).queues.get("a")?.length === 1);
  assert.equal(store.read('["host","a"]').submission?.state, "prepared");
  const preparedId = store.read('["host","a"]').submission!.id;
  // Model app reload dropping Paseo's memory queue; restore only never-dispatched work.
  await page.evaluate(() => { const state = window as any; state.stopProbe(); state.queues.clear(); state.stopProbe = state.startProbe(); });
  await page.locator("#a summary").click();
  await page.locator("#a").getByRole("button", { name: "Arm this disposable chat", exact: true }).click();
  await page.locator("#a [aria-live]").filter({ hasText: "prepared" }).waitFor();
  await page.locator("#a").getByRole("button", { name: "Restore unsent batch to native queue", exact: true }).click();
  await page.waitForFunction(() => (window as any).queues.get("a")?.length === 1);
  assert.equal(store.read('["host","a"]').submission!.id, preparedId);
  await page.evaluate(async () => {
    const state = window as any, item = state.queues.get("a")[0]; state.queues.delete("a");
    await state.native.sendAgentMessage("a", item.text, { messageId: "queued-native-id", activeTurnBehavior: "steer", attachments: item.attachments });
    state.stopProbe();
  });
  assert.equal(store.read('["host","a"]').submission, null);
  assert.equal(await page.locator("[data-tether-delivery-probe]").count(), 0);
  assert.equal(await page.evaluate(() => (window as any).native.sendAgentMessage === (window as any).originalSend), true);
  console.log("PASS: synthetic Chromium capture/replay, delayed save, click and Enter, chat isolation, attachments, queue dispatch/reload recovery, ambiguous acceptance/reload reconciliation, no duplicate, cleanup and teardown. Not a live Paseo test.");
} finally { await browser.close(); owner.close(); }
