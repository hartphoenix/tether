/// <reference lib="dom" />
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { probeRpc } from "./contracts";
import { ProbeController } from "./controller";
import { composer, inputs, isNativeSendButton, queueWriter, replaceText, scope, type Composer, type NativeClient } from "./native";

/** Test-only UI. Installed separately; it never enables itself for an existing chat. */
export default function contribute(client: PluginClientContext) {
  if (typeof document === "undefined" || !(globalThis as { paseoDesktop?: unknown }).paseoDesktop) return () => {};
  const ownership = Symbol.for("tether.paseo.annotation-adapter");
  const global = globalThis as unknown as Record<symbol, object | undefined>;
  if (global[ownership]) return () => {};
  const owner = {}; global[ownership] = owner;
  const chats = new Map<string, { controller: ProbeController; host: string; agent: string; input: HTMLTextAreaElement; status: HTMLElement; busy: boolean }>();
  const panels = new Map<HTMLTextAreaElement, { key: string; panel: HTMLElement }>();
  const patched = new Map<NativeClient, { original: NativeClient["sendAgentMessage"]; wrapper: NativeClient["sendAgentMessage"] }>();
  let stopped = false;
  const status = (key: string, text?: string) => {
    const chat = chats.get(key);
    if (!chat) return;
    const { drafts, submission } = chat.controller.state;
    chat.status.textContent = text ?? `${drafts.length} saved · ${submission ? `${submission.state} · ${submission.messageId ?? "not dispatched / possibly queued"}` : "ready"}`;
  };
  const installTransport = (c: Composer) => {
    if (patched.has(c.client)) return;
    const original = c.client.sendAgentMessage;
    const wrapper: NativeClient["sendAgentMessage"] = async (agent, text, options) => {
      const key = JSON.stringify([c.voiceServerId, agent]);
      const chat = chats.get(key);
      if (!chat) return original.call(c.client, agent, text, options);
      const pending = chat.controller.state.submission;
      try { await chat.controller.send(original.bind(c.client), agent, text, options); status(key); }
      catch (error) {
        status(key, String(error));
        if (pending && !chat.controller.state.submission) setTimeout(() => {
          if (!stopped && chat.input.value === pending.text) replaceText(chat.input, pending.prose);
        }, 0);
        throw error;
      }
    };
    c.client.sendAgentMessage = wrapper;
    patched.set(c.client, { original, wrapper });
  };
  const button = (label: string, action: () => void) => {
    const b = document.createElement("button"); b.textContent = label; b.type = "button"; b.onclick = action; return b;
  };
  const scan = () => {
    for (const [input, { panel }] of panels) if (!input.isConnected) { panel.remove(); panels.delete(input); }
    for (const input of inputs()) {
      const c = composer(input);
      if (!c) continue;
      const key = scope(c), active = chats.get(key);
      if (active) { active.input = input; installTransport(c); }
      const existing = panels.get(input);
      if (existing?.key === key) continue;
      existing?.panel.remove();
      const panel = document.createElement("details");
      panel.dataset.tetherDeliveryProbe = "true";
      panel.style.cssText = "font:12px system-ui;color:inherit;background:inherit;border:1px solid currentColor;padding:8px;margin:4px;max-height:300px;overflow:auto";
      const title = document.createElement("summary"); title.textContent = "Tether delivery prototype (disposable chats only)";
      panel.append(title);
      const output = document.createElement("p"); output.setAttribute("aria-live", "polite"); output.textContent = "Inactive. Disable Annotations before arming this test chat.";
      const quote = document.createElement("textarea"); quote.placeholder = "Test quote"; quote.setAttribute("aria-label", "Test quote");
      const feedback = document.createElement("textarea"); feedback.placeholder = "Feedback (may be empty)"; feedback.setAttribute("aria-label", "Test feedback");
      for (const field of [quote, feedback]) field.style.cssText = "display:block;width:100%;color:inherit;background:inherit;border:1px solid currentColor;margin:4px 0";
      let draftId = crypto.randomUUID();
      const act = (task: () => Promise<unknown>) => { void task().catch(error => { output.textContent = String(error); }); };
      panel.append(output, button("Arm this disposable chat", () => act(async () => {
        const current = composer(input);
        if (!current || scope(current) !== key) throw new Error("Chat changed; reopen the test panel.");
        if (!chats.has(key)) {
          const controller = new ProbeController(operation => client.rpc(probeRpc, { host: current.voiceServerId, agent: current.voiceAgentId, operation }), () => status(key));
          chats.set(key, { controller, host: current.voiceServerId, agent: current.voiceAgentId, input, status: output, busy: false });
        }
        const chat = chats.get(key)!;
        chat.status = output;
        installTransport(current);
        await chat.controller.refresh();
        status(key);
      })), quote, feedback,
      button("Save quote", () => act(async () => {
        const chat = chats.get(key); if (!chat) throw new Error("Arm this disposable chat first.");
        if (!quote.value) throw new Error("Enter a test quote.");
        await chat.controller.run({ kind: "save", draft: { id: draftId, quote: quote.value, feedback: feedback.value } });
        status(key);
      })),
      button("New quote", () => { draftId = crypto.randomUUID(); quote.value = ""; feedback.value = ""; }),
      button("Inspect / refresh", () => act(async () => {
        const chat = chats.get(key); if (!chat) throw new Error("Arm first.");
        await chat.controller.refresh();
        output.textContent = JSON.stringify(chat.controller.state, null, 2);
      })),
      button("Reconcile acceptance", () => act(async () => {
        const chat = chats.get(key), current = composer(input); if (!chat || !current) throw new Error("Arm first.");
        const found = await chat.controller.reconcile(current.client, chat.agent);
        status(key, found ? "Acceptance confirmed by daemon timeline; stored payload and captured drafts deleted." : "No acceptance proof found. Saved work retained; no resend attempted.");
      })),
      button("Restore unsent batch to native queue", () => act(async () => {
        const chat = chats.get(key), current = composer(input), queue = queueWriter(input);
        if (!chat || !current || scope(current) !== key || !queue) throw new Error("Native queue adapter unavailable; saved work retained.");
        await chat.controller.refresh();
        const pending = chat.controller.state.submission;
        if (!pending || pending.state !== "prepared") throw new Error("Only never-dispatched work can be restored. Reconcile uncertain delivery.");
        if (queue.read(chat.agent).length) throw new Error("Native queue still has work. Nothing restored.");
        // Explicit recovery into the native queue; no transport call and no new submission ID.
        queue.write(before => new Map(before).set(chat.agent, [{ id: pending.id, text: pending.text, attachments: pending.attachments }]));
        status(key, "Restored to native queue with the saved batch identity. Native controls govern dispatch.");
      })),
      button("Release never-dispatched batch for editing", () => act(async () => {
        const chat = chats.get(key), current = composer(input), queue = queueWriter(input);
        if (!chat || !current || scope(current) !== key || !queue) throw new Error("Native queue adapter unavailable.");
        await chat.controller.refresh();
        const pending = chat.controller.state.submission;
        if (!pending || pending.state !== "prepared") throw new Error("Only never-dispatched work can be released.");
        if (queue.read(chat.agent).length) throw new Error("Use Paseo’s queue edit action first; native queued work must not be duplicated.");
        await chat.controller.run({ kind: "cancelPrepared", id: pending.id });
        if (input.value === pending.text) replaceText(input, pending.prose);
        status(key);
      })),
      button("Known failure on next dispatch", () => { const chat = chats.get(key); if (chat) { chat.controller.fault = "before-send"; status(key, "Next dispatch will fail before transport."); } }),
      button("Lose next acceptance", () => { const chat = chats.get(key); if (chat) { chat.controller.fault = "after-acceptance"; status(key, "Next accepted send will retain uncertainty for reconciliation."); } }));
      const root = input.closest('[data-testid="message-input-root"]');
      if (!root?.parentElement) continue;
      root.parentElement.append(panel); panels.set(input, { key, panel });
    }
  };
  const replay = new WeakSet<Event>();
  const intercept = (event: Event) => {
    if (replay.has(event) || stopped) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("[data-tether-delivery-probe]")) return;
    let input: HTMLTextAreaElement | null = null;
    if (event instanceof KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      if (target.matches("textarea[data-composer-input]")) input = target as HTMLTextAreaElement;
    } else {
      const pressed = target.closest<HTMLButtonElement>('button,[role="button"]');
      const root = pressed?.closest('[data-testid="message-input-root"]');
      if (!pressed || !root || pressed.disabled || pressed.getAttribute("aria-disabled") === "true" || !isNativeSendButton(pressed)) return;
      input = root.querySelector("textarea[data-composer-input]");
    }
    if (!input) return;
    const c = composer(input); if (!c) return;
    const key = scope(c), chat = chats.get(key); if (!chat) return;
    // Let slash-command/autocomplete interaction remain native. It never captures a batch.
    if (input.value.trimStart().startsWith("/") || input.getAttribute("aria-expanded") === "true") return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (chat.busy) return;
    if (input.readOnly || input.disabled || c.disabled || c.readOnly || c.isSubmitDisabled) { status(key, "Native composer disabled; batch retained."); return; }
    if (chat.controller.state.submission) { status(key, "Pending submission retained. Inspect or reconcile before another ordinary send."); return; }
    chat.busy = true;
    const source = input, before = source.value, attachments = JSON.stringify(c.attachments);
    const clone = event instanceof KeyboardEvent ? new KeyboardEvent(event.type, { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true }) : new MouseEvent("click", { bubbles: true, cancelable: true });
    void (async () => {
      installTransport(c);
      const state = await chat.controller.capture(before, c.attachments);
      const fresh = composer(source);
      if (stopped || !source.isConnected || !fresh || scope(fresh) !== key || source.value !== before || JSON.stringify(fresh.attachments) !== attachments) throw new Error("Composer changed during save. Prepared batch retained; no native action replayed.");
      replaceText(source, state.submission!.text);
      // Replay the original native input action, retaining its queue/steer/interrupt choice.
      replay.add(clone); target.dispatchEvent(clone);
      status(key);
    })().catch(error => status(key, String(error))).finally(() => { chat.busy = false; });
  };
  document.addEventListener("keydown", intercept, true);
  document.addEventListener("click", intercept, true);
  const timer = setInterval(scan, 500); scan();
  return () => {
    stopped = true; clearInterval(timer);
    document.removeEventListener("keydown", intercept, true); document.removeEventListener("click", intercept, true);
    for (const { panel } of panels.values()) panel.remove();
    for (const [native, patch] of patched) if (native.sendAgentMessage === patch.wrapper) native.sendAgentMessage = patch.original;
    chats.clear();
    if (global[ownership] === owner) delete global[ownership];
  };
}
