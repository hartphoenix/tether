import type { CollectionHost } from "./collections";
/// <reference lib="dom" />
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { chatRpc, reconcileRpc } from "./contracts";
import { ChatController } from "./controller";
import { composer, inputs, isNativeSendButton, queuedEdit, queueWriter, replaceText, scope, type Composer, type NativeClient, type QueueWriter } from "./native";
import { queuedBatch, stripBatchCarrier } from "./queue";
import { startChatUi, type UiChat } from "./ui";
import { startSubmittedAnnotations } from "./submitted-ui";

export function startChatAnnotations(client: PluginClientContext, getGeneration: () => string | null, collections: CollectionHost) {
  if (typeof document === "undefined" || !(globalThis as { paseoDesktop?: unknown }).paseoDesktop) { collections.dispose(); return () => {}; }
  // Prototype and production must never wrap the same native transport together.
  const ownership = Symbol.for("tether.paseo.annotation-adapter");
  const global = globalThis as unknown as Record<symbol, object | undefined>;
  if (document.querySelector('[data-tether-delivery-probe]') || global[ownership]) { collections.dispose(); return () => {}; }
  const owner = {}; global[ownership] = owner;
  const submitted = startSubmittedAnnotations();
  type Chat = UiChat & { host: string; agent: string; busy: boolean; generation: string | null; direct?: string; queue?: QueueWriter; refreshing?: boolean; refreshedAt?: number };
  const chats = new Map<string, Chat>();
  const ui = startChatUi(chats, collections);
  const patched = new Map<NativeClient, { original: NativeClient["sendAgentMessage"]; wrapper: NativeClient["sendAgentMessage"]; deleteOriginal?: NativeClient["deleteAgent"]; deleteWrapper?: NativeClient["deleteAgent"] }>();
  const queues = new Map<QueueWriter, { original: QueueWriter["write"]; wrapper: QueueWriter["write"] }>();
  let stopped = false;
  const update = () => { ui.render(); ui.refreshMarks(); };
  const notice = (chat: Chat, message: string) => { chat.notice = message; ui.render(); };
  const install = (c: Composer, chat: Chat) => {
    const queue = queueWriter(chat.input);
    if (queue) {
      chat.queue = queue;
      if (!queues.has(queue)) {
        const write = queue.write;
        const wrapper: QueueWriter["write"] = updater => write(before => {
          const next = updater(before);
          for (const [key, active] of chats) {
            if (active.host !== c.voiceServerId) continue;
            const p = active.controller.state.submission;
            if (!p || active.direct !== p.id) continue;
            const oldIds = new Set((before.get(active.agent) ?? []).map(i => i.id));
            const items = next.get(active.agent) ?? [];
            const added = items.filter(i => !oldIds.has(i.id) && i.text === p.text);
            if (added.length === 1) {
              // Attach durable identity before the native store publishes the queue row.
              const item = added[0];
              next.set(active.agent, items.map(i => i === item ? queuedBatch({ ...p, attachments: item.attachments }, active.host, active.agent) : i));
              active.direct = undefined;
            }
          }
          return next;
        });
        queues.set(queue, { original: write, wrapper });
        queue.write = wrapper;
      }
    }
    if (patched.has(c.client)) return;
    const original = c.client.sendAgentMessage;
    const wrapper: NativeClient["sendAgentMessage"] = async (agent, text, options) => {
      // Non-composer callers may omit options; leave their native path untouched.
      if (!options) return original.call(c.client, agent, text, options);
      const active = chats.get(JSON.stringify([c.voiceServerId, agent]));
      const carrier = stripBatchCarrier(options);
      if (!active) {
        if (carrier.id) throw new Error("Saved annotation batch is unavailable. Open its chat before sending.");
        return original.call(c.client, agent, text, options);
      }
      await active.ready;
      const pending = active.controller.state.submission;
      const id = carrier.id ?? active.direct;
      if (!id && pending && text === pending.text) throw new Error("This text belongs to a pending annotation batch. Recover or check acceptance first.");
      if (id) active.direct = undefined;
      try {
        await active.controller.send(original.bind(c.client), agent, text, carrier.options, id);
        if (id && pending && active.input.value === pending.text && composer(active.input) && scope(composer(active.input)!) === JSON.stringify([active.host, active.agent])) replaceText(active.input, "");
        notice(active, "");
      } catch (error) { notice(active, String(error)); throw error; }
    };
    const deleteOriginal = c.client.deleteAgent;
    const deleteWrapper = deleteOriginal ? async (agent: string) => {
      await deleteOriginal.call(c.client, agent);
      const active = chats.get(JSON.stringify([c.voiceServerId, agent]));
      // Only a successful permanent delete, never archive/close/list absence.
      if (active) { await active.controller.refresh(); await active.controller.run({ kind: "deleteChat" }); }
      else await client.rpc(chatRpc, { generation: getGeneration() ?? undefined, host: c.voiceServerId, agent, operation: { kind: "deleteChat" } });
    } : undefined;
    c.client.sendAgentMessage = wrapper;
    if (deleteWrapper) c.client.deleteAgent = deleteWrapper;
    patched.set(c.client, { original, wrapper, deleteOriginal, deleteWrapper });
  };
  const scan = () => {
    if (stopped) return;
    for (const input of inputs()) {
      const c = composer(input); if (!c) continue;
      const key = scope(c); let chat = chats.get(key);
      if (!chat) {
        let generation: string | null = null;
        const controller = new ChatController(operation => client.rpc(chatRpc, { generation: generation ?? undefined, host: c.voiceServerId, agent: c.voiceAgentId, operation }), update);
        chat = { controller, input, generation, refresh: async () => {
          const active = chats.get(key)!;
          if (active.generation && active.generation !== getGeneration()) throw new Error("Tether connection changed. Reload Paseo before editing annotations.");
          generation = getGeneration(); active.generation = generation;
          if (!generation) throw new Error("Tether is not connected yet.");
          active.ready = controller.refresh();
          await active.ready; notice(active, "");
        }, host: c.voiceServerId, agent: c.voiceAgentId, busy: false, notice: "Loading annotations…", ready: Promise.resolve(),
          recover: async () => {
            const active = chats.get(key)!; await active.ready;
            await active.controller.refresh();
            const p = active.controller.state.submission, q = active.queue;
            if (!p || p.state !== "prepared" || !q) throw new Error("Only a never-dispatched batch can be restored.");
            if (active.input.value === p.text && composer(active.input) && scope(composer(active.input)!) === key) replaceText(active.input, "");
            if (!q.read(active.agent).some(i => i.id === p.id)) q.write(before => new Map(before).set(active.agent, [...(before.get(active.agent) ?? []), queuedBatch(p, active.host, active.agent)]));
            notice(active, "Restored to the native queue. Use its send arrow if the agent is already idle, or its edit control to change the batch.");
          },
          reconcile: async () => {
            const active = chats.get(key)!; await active.ready;
            const current = composer(active.input); if (!current || scope(current) !== key) throw new Error("Reopen the original chat to check acceptance.");
            const pending = active.controller.state.submission;
            const found = await active.controller.reconcile(() => client.rpc(reconcileRpc, { generation: active.generation!, host: active.host, agent: active.agent }), current.client, active.agent);
            if (found && pending) {
              if (active.input.value === pending.text && composer(active.input) && scope(composer(active.input)!) === key) replaceText(active.input, "");
              active.queue?.write(before => new Map(before).set(active.agent, (before.get(active.agent) ?? []).filter(i => i.id !== pending.id)));
            }
            notice(active, found ? "Acceptance confirmed; delivered annotations removed." : "Acceptance is still uncertain. Saved work retained; no resend attempted.");
          },
        };
        chats.set(key, chat);
        chat.ready = (async () => {
          for (let tries = 0; !getGeneration() && tries < 40 && !stopped; tries++) await new Promise(r => setTimeout(r, 250));
          if (stopped) return;
          generation = getGeneration(); chat!.generation = generation;
          if (!generation) throw new Error("Tether is not connected. Refresh annotations when it is available.");
          await controller.refresh(); notice(chat!, "");
        })().catch(error => { notice(chat!, String(error)); throw error; });
        void chat.ready.catch(() => {});
      }
      chat.input = input; install(c, chat);
      // Go delivery can accept a batch outside this composer. Refresh through the
      // controller's serial boundary so stale reads cannot overwrite local saves.
      if (!chat.busy && !chat.refreshing && chat.generation === getGeneration() && Date.now() - (chat.refreshedAt ?? 0) >= 2_000) {
        const active = chat;
        active.refreshing = true;
        void active.ready.then(() => active.controller.refresh()).catch(error => notice(active, String(error)))
          .finally(() => { active.refreshing = false; active.refreshedAt = Date.now(); });
      }
    }
    submitted.refresh(); ui.render();
  };
  const replay = new WeakSet<Event>();
  const intercept = (event: Event) => {
    if (stopped || replay.has(event)) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('[data-tether-chat]')) return;
    let input: HTMLTextAreaElement | null = null;
    if (event instanceof KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      if (target.matches('textarea[data-composer-input]')) input = target as HTMLTextAreaElement;
    } else {
      const pressed = target.closest<HTMLElement>('button,[role="button"]');
      if (!pressed) return;
      const edit = queuedEdit(pressed);
      if (edit) {
        const chat = [...chats.values()].find(a => a.controller.state.submission?.id === edit.item.id);
        if (!chat) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void (async () => {
          await chat.ready; await ui.flush(scope(composer(chat.input)!));
          const p = chat.controller.state.submission;
          if (!p || p.state !== "prepared") throw new Error("Delivery uncertain. Check acceptance before editing.");
          if (chat.input.value.trim()) throw new Error("Clear the composer before recovering the queued batch for editing.");
          // Native edit restores user attachments; its workspace-only carrier is omitted.
          edit.edit(edit.item.id);
          await chat.controller.run({ kind: "cancelPrepared", id: p.id });
          if (chat.input.value === p.text) replaceText(chat.input, p.prose);
          notice(chat, "Batch recovered for editing. Saved annotations will join the next send.");
        })().catch(e => notice(chat, String(e)));
        return;
      }
      const root = pressed.closest('[data-testid="message-input-root"]');
      if (!root || !isNativeSendButton(pressed) || pressed.getAttribute("aria-disabled") === "true" || (pressed as HTMLButtonElement).disabled) return;
      input = root.querySelector('textarea[data-composer-input]');
    }
    if (!input) return;
    const c = composer(input); if (!c) return;
    const key = scope(c), chat = chats.get(key); if (!chat) return;
    if (input.value.trimStart().startsWith("/") || input.getAttribute("aria-expanded") === "true") return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (chat.busy || input.disabled || input.readOnly || c.disabled || c.readOnly) return;
    chat.busy = true;
    const source = input, before = source.value, attachments = JSON.stringify(c.attachments);
    const clone = event instanceof KeyboardEvent ? new KeyboardEvent(event.type, { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, bubbles: true, cancelable: true }) : new MouseEvent("click", { bubbles: true, cancelable: true });
    void (async () => {
      await chat.ready; await ui.flush(key);
      const pending = chat.controller.state.submission;
      const unsent = chat.controller.state.drafts.filter(d => !pending?.draftIds.includes(d.id));
      if (pending && (unsent.length || before === pending.text)) throw new Error("An annotation batch is awaiting delivery. Recover or check its acceptance first.");
      if (!pending && unsent.length) {
        if (!chat.queue) throw new Error("Native queue adapter unavailable; annotations retained.");
        const state = await chat.controller.capture(before, c.attachments);
        chat.direct = state.submission?.id;
      }
      const fresh = composer(source);
      if (stopped || !source.isConnected || !fresh || scope(fresh) !== key || source.value !== before || JSON.stringify(fresh.attachments) !== attachments) { chat.direct = undefined; throw new Error("Composer changed while saving. Recover the saved batch before sending."); }
      if (chat.direct) replaceText(source, chat.controller.state.submission!.text);
      // React has to publish the updated native disabled/send state first.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const afterFrame = composer(source);
      const expected = chat.direct ? chat.controller.state.submission?.text : before;
      if (stopped || !source.isConnected || !afterFrame || scope(afterFrame) !== key || source.value !== expected || JSON.stringify(afterFrame.attachments) !== attachments) {
        chat.direct = undefined; throw new Error("Composer changed before dispatch. Saved annotations retained.");
      }
      replay.add(clone); target.dispatchEvent(clone);
      notice(chat, "");
    })().catch(e => notice(chat, String(e))).finally(() => { chat.busy = false; });
  };
  document.addEventListener("keydown", intercept, true); document.addEventListener("click", intercept, true);
  const timer = setInterval(scan, 500); scan();
  return () => {
    stopped = true; clearInterval(timer);
    document.removeEventListener("keydown", intercept, true); document.removeEventListener("click", intercept, true);
    ui.dispose();
    submitted.dispose();
    for (const [native, patch] of patched) {
      if (native.sendAgentMessage === patch.wrapper) native.sendAgentMessage = patch.original;
      if (patch.deleteWrapper && native.deleteAgent === patch.deleteWrapper) native.deleteAgent = patch.deleteOriginal;
    }
    for (const [queue, patch] of queues) if (queue.write === patch.wrapper) queue.write = patch.original;
    chats.clear();
    if (global[ownership] === owner) delete global[ownership];
  };
}
