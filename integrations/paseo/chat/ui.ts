import type { CollectionHost } from "./collections";
import { commentWindowCss } from "../../../src/shared/comment-window";
import { themePresets } from "../../../src/shared/theme-presets";
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { reviewNoteIconSvg } from "./icon";
import { chatCss } from "./style";
import { element, findAnchor, inputAround, ownSelector, readSelection, transcriptSelector, type Passage } from "./dom";
import { composer, scope } from "./native";
import type { ChatController } from "./controller";
import type { Draft } from "./model";

export type UiChat = { controller: ChatController; input: HTMLTextAreaElement; ready: Promise<unknown>; notice: string; refresh: () => Promise<void>; recover: () => Promise<void>; reconcile: () => Promise<void> };
export function button(label: string, action: () => void) { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = action; return b; }
export function startChatUi(chats: Map<string, UiChat>, collections: CollectionHost) {
  const style = document.createElement("style"); style.textContent = chatCss + commentWindowCss; document.head.append(style);
  const menu = document.createElement("div"); menu.dataset.tetherChat = "menu"; menu.hidden = true; menu.style.display = "none"; menu.setAttribute("role", "toolbar"); menu.setAttribute("aria-label", "Selected passage"); document.body.append(menu);
  let passage: Passage | null = null, stopped = false;
  let preferred: { x: number; y: number } | null = null;
  let card: { key: string; draft: Draft; sourceRange?: Range; persisted: boolean; node: HTMLElement; field: HTMLTextAreaElement; error: HTMLElement; saving?: Promise<void> } | null = null;
  let geometryObserver: ResizeObserver | undefined;
  const observed = new Set<HTMLElement>();
  const panels = new Map<string, { node: HTMLDivElement; signature: string; status: HTMLElement; list: HTMLOListElement; recovery: HTMLElement }>();
  const marks: { key: string; id: string; range: Range; badge: HTMLElement; mount: HTMLElement; oldPosition: string; changedPosition: boolean }[] = [];
  const hideMenu = () => { menu.hidden = true; menu.style.display = "none"; };
  const place = (node: HTMLElement, x: number, y: number) => {
    node.style.left = `${Math.max(8, Math.min(x, innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(y, innerHeight - node.offsetHeight - 8))}px`;
  };
  const close = () => { card?.node.remove(); card = null; };
  async function flush(key?: string): Promise<void> {
    const current = card;
    if (!current || key && current.key !== key) return;
    if (current.saving) { await current.saving; if (card === current) return flush(key); return; }
    const chat = chats.get(current.key);
    if (!chat) throw new Error("Original chat is unavailable; annotation remains open.");
    const snapshot = current.field.value;
    current.saving = (async () => {
      await chat.ready;
      if (chat.controller.state.submission?.draftIds.includes(current.draft.id)) { close(); return; }
      await chat.controller.save({ ...current.draft, feedback: snapshot });
      if (card === current && current.field.value === snapshot) close();
      render(); refreshMarks();
    })().catch(error => { current.error.textContent = String(error); throw error; }).finally(() => { current.saving = undefined; });
    await current.saving;
    if (card === current) return flush(key);
  }
  async function open(key: string, draft: Draft, rect?: Passage["rect"], sourceRange?: Range) {
    await flush(); if (stopped) return;
    hideMenu();
    const chat = chats.get(key); if (!chat) return;
    await chat.ready; if (stopped) return;
    const node = document.createElement("section"); node.dataset.tetherChat = "card"; node.setAttribute("role", "dialog"); node.setAttribute("aria-label", "Comment on passage");
    node.classList.add("tether-comment-window");
    const field = document.createElement("textarea"); field.value = draft.feedback; field.placeholder = "Comment..."; field.setAttribute("aria-label", "Comment");
    field.readOnly = !!chat.controller.state.submission?.draftIds.includes(draft.id);
    const error = document.createElement("p"); error.setAttribute("role", "status");
    if (field.readOnly) error.textContent = "Awaiting delivery. Recover the batch before editing.";
    const footer = document.createElement("footer"); footer.className = "tether-comment-actions";
    const cancel = button("Cancel", () => { close(); refreshMarks(); });
    const submit = button("Comment", () => { void flush().catch(() => {}); }); submit.dataset.primary = ""; submit.disabled = field.readOnly;
    footer.append(cancel, submit);
    node.append(field, error, footer); document.body.append(node);
    syncCardTheme(node);
    card = { key, draft, sourceRange, persisted: chat.controller.state.drafts.some(d => d.id === draft.id), node, field, error };
    const inputRect = chat.input.getBoundingClientRect();
    const start = preferred ?? { x: rect?.left ?? inputRect.left, y: rect ? rect.bottom + 8 : Math.max(8, inputRect.top - node.offsetHeight - 8) };
    place(node, start.x, start.y);
    let drag: { id: number; dx: number; dy: number } | null = null;
    node.onpointerdown = e => {
      if (e.button !== 0 || element(e.target as Node).closest("button,textarea,input,a,blockquote,[contenteditable]")) return;
      const r = node.getBoundingClientRect(); drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top }; node.setPointerCapture(e.pointerId); e.preventDefault();
    };
    node.onpointermove = e => { if (!drag) return; preferred = { x: e.clientX - drag.dx, y: e.clientY - drag.dy }; place(node, preferred.x, preferred.y); };
    node.onpointerup = node.onpointercancel = () => { drag = null; };
    field.focus({ preventScroll: true });
    refreshMarks();
  }
  const comment = button("", () => { if (passage) void open(passage.key, passage.draft, passage.rect, passage.range).catch(e => { const chat = chats.get(passage!.key); if (chat) chat.notice = String(e); render(); }); });
  comment.innerHTML = reviewNoteIconSvg; comment.title = "Comment"; comment.setAttribute("aria-label", "Comment");
  const copy = button("", () => { if (passage) void navigator.clipboard.writeText(passage.draft.quote).then(hideMenu, () => { copy.title = "Copy failed; use the native copy command"; }); });
  copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
  copy.title = "Copy"; copy.setAttribute("aria-label", "Copy"); menu.append(comment, copy);
  menu.onpointerdown = e => e.preventDefault();
  const selectionChanged = () => {
    const next = readSelection();
    if (!next || !chats.has(next.key)) { hideMenu(); return; }
    passage = next; menu.hidden = false; menu.style.display = "flex"; place(menu, next.rect.left, next.rect.top - 48);
  };
  const outside = (event: PointerEvent) => {
    const target = event.target as Node;
    if (card && !card.node.contains(target) && !menu.contains(target)) void flush().catch(() => {});
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && card) { event.preventDefault(); void flush().catch(() => {}); } };
  const resize = () => { hideMenu(); if (card) { const r = card.node.getBoundingClientRect(); place(card.node, preferred?.x ?? r.left, preferred?.y ?? r.top); } refreshMarks(); };
  const clickPassage = (event: MouseEvent) => {
    if ((event.target as Element)?.closest(ownSelector) || !window.getSelection()?.isCollapsed) return;
    const match = marks.find(m => [...m.range.getClientRects()].some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom));
    if (match) { const draft = chats.get(match.key)?.controller.state.drafts.find(d => d.id === match.id); if (draft) void open(match.key, draft, match.range.getBoundingClientRect(), match.range).catch(() => {}); }
  };
  function syncCardTheme(node: HTMLElement) {
    const css = getComputedStyle(document.documentElement);
    const background = css.getPropertyValue("--colors-surface0").trim().toLowerCase();
    const foreground = css.getPropertyValue("--colors-foreground").trim().toLowerCase();
    const palette = Object.values(themePresets).find(p => p.colors.background.toLowerCase() === background && p.colors["on-background"].toLowerCase() === foreground)?.colors;
    const vars: Record<string, string> = {
      surface: "var(--colors-surface1)", input: "var(--colors-surface0)", text: "var(--colors-foreground)", muted: "var(--colors-foreground-muted)",
      outline: palette?.outline ?? "var(--colors-border)", control: palette?.["surface-low"] ?? "var(--colors-surface2)",
      primary: palette?.secondary ?? "var(--colors-accent)", "on-primary": palette?.["on-secondary"] ?? "var(--colors-accent-foreground)",
      border: `color-mix(in srgb,${palette?.outline ?? "var(--colors-foreground)"},transparent 65%)`,
    };
    for (const [key, value] of Object.entries(vars)) node.style.setProperty(`--tc-${key}`, value);
  }
  function render() {
    if (card) syncCardTheme(card.node);
    if (stopped) return;
    if (card?.persisted && !chats.get(card.key)?.controller.state.drafts.some(d => d.id === card!.draft.id) && card.field.value === card.draft.feedback) close();
    for (const [key, chat] of chats) {
      const root = chat.input.closest('[data-testid="message-input-root"]');
      if (!root?.parentElement || !chat.input.isConnected || !composer(chat.input) || scope(composer(chat.input)!) !== key) { panels.get(key)?.node.remove(); collections.remove(key); panels.delete(key); continue; }
      let panel = panels.get(key);
      if (!panel) {
        const node = document.createElement("div"); node.dataset.tetherChat = "batch";
        const status = document.createElement("p"), list = document.createElement("ol"), recovery = document.createElement("div"); status.setAttribute("aria-live", "polite");
        node.append(list, status, recovery); panel = { node, status, list, recovery, signature: "" }; panels.set(key, panel);
      }
      const { drafts, submission } = chat.controller.state;
      collections.update(key, chat.input, panel.node, `${drafts.length} annotation${drafts.length === 1 ? "" : "s"}`, !!drafts.length || !!submission || !!chat.notice);
      panel.status.textContent = chat.notice || (submission?.state === "dispatching" ? "Delivery uncertain. Check acceptance before retrying." : submission ? "Batch saved for delivery." : "");
      const signature = JSON.stringify([drafts, submission?.id, submission?.state, chat.notice]);
      if (panel.signature === signature) continue;
      panel.signature = signature; panel.list.replaceChildren(); panel.recovery.replaceChildren();
      drafts.forEach((draft, i) => {
        const li = document.createElement("li"), edit = button("", () => { void open(key, draft).then(() => panel!.node.dispatchEvent(new Event("tether-edit-annotation"))).catch(e => { chat.notice = String(e); render(); }); });
        edit.className = "tether-collection-edit"; edit.title = `Edit annotation ${i + 1}`; edit.setAttribute("aria-label", `Edit annotation ${i + 1}`);
        const number = document.createElement("span"); number.className = "tether-collection-number"; number.textContent = String(i + 1);
        const label = document.createElement("span"); label.className = "tether-collection-label"; label.textContent = draft.feedback.trim() || draft.quote.replace(/\s+/g, " ");
        edit.append(number, label);
        if (draft.feedback.trim()) { const quote = document.createElement("span"); quote.className = "tether-collection-quote"; quote.textContent = draft.quote.replace(/\s+/g, " "); edit.append(quote); }
        const remove = button("", () => { void chat.controller.run({ kind: "remove", id: draft.id }).then(() => { render(); refreshMarks(); }).catch(e => { chat.notice = String(e); render(); }); });
        remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
        remove.className = "tether-collection-delete"; remove.title = `Delete annotation ${i + 1}`;
        remove.setAttribute("aria-label", `Delete annotation ${i + 1}`); remove.disabled = !!submission?.draftIds.includes(draft.id);
        li.append(edit, remove); panel!.list.append(li);
      });
      const clear = button("Clear all", () => { void (async () => {
        await flush(key); await chat.controller.refresh();
        const pending = chat.controller.state.submission;
        for (const draft of [...chat.controller.state.drafts]) if (!pending?.draftIds.includes(draft.id)) await chat.controller.run({ kind: "remove", id: draft.id });
        render(); refreshMarks();
      })().catch(e => { chat.notice = String(e); render(); }); });
      clear.disabled = !drafts.some(d => !submission?.draftIds.includes(d.id)); clear.setAttribute("aria-label", "Remove all annotations");
      panel.recovery.append(clear);
      if (chat.notice) panel.recovery.append(button("Refresh annotations", () => { void chat.refresh().catch(e => { chat.notice = String(e); render(); }); }));
      if (submission) panel.recovery.append(button(submission.state === "dispatching" ? "Check acceptance" : "Restore queued batch", () => {
        void (submission.state === "dispatching" ? chat.reconcile() : chat.recover()).catch(e => { chat.notice = String(e); render(); });
      }));
    }
  }
  function clearMarks() {
    for (const mark of marks.splice(0)) {
      mark.badge.remove();
      if (mark.changedPosition && mark.mount.style.position === "relative") mark.mount.style.position = mark.oldPosition;
    }
  }
  function refreshMarks() {
    if (stopped) return;
    clearMarks();
    for (const node of observed) if (!node.isConnected) { geometryObserver?.unobserve(node); observed.delete(node); }
    const ranges: Range[] = card?.sourceRange?.startContainer.isConnected ? [card.sourceRange] : [];
    for (const transcript of document.querySelectorAll<HTMLElement>(transcriptSelector)) {
      if (!observed.has(transcript)) { observed.add(transcript); geometryObserver?.observe(transcript); }
      if (!transcript.getClientRects().length) continue;
      const input = inputAround(transcript), c = input && composer(input), key = c && scope(c), chat = key && chats.get(key);
      if (!chat || !key) continue;
      chat.controller.state.drafts.forEach((draft, index) => {
        if (!draft.anchor) return;
        const range = findAnchor(transcript, draft.anchor); if (!range) return;
        ranges.push(range);
        // Mount in the text's coordinate space. Native scrolling, including nested
        // tool scrollers, moves and clips badges without JS scroll scheduling.
        let mount = element(range.startContainer);
        // A wrapped inline's bounding box is not its absolute-position origin:
        // its first fragment can begin halfway across a different line.
        while (mount.parentElement && /^(inline|contents)$/.test(getComputedStyle(mount).display)) mount = mount.parentElement;
        const rect = range.getClientRects()[0]; if (!rect) return;
        const oldPosition = mount.style.position, changedPosition = getComputedStyle(mount).position === "static";
        if (changedPosition) mount.style.position = "relative";
        const base = mount.getBoundingClientRect(), badge = button(String(index + 1), () => { void open(key, draft, range.getBoundingClientRect(), range).catch(() => {}); });
        badge.dataset.tetherChat = "badge"; badge.setAttribute("aria-label", `Edit annotation ${index + 1}`);
        badge.style.left = `${rect.left - base.left + mount.scrollLeft - mount.clientLeft}px`;
        badge.style.top = `${rect.top - base.top + mount.scrollTop - mount.clientTop - 9}px`;
        mount.append(badge); marks.push({ key, id: draft.id, range, badge, mount, oldPosition, changedPosition });
      });
    }
    const api = globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: { set(key: string, value: unknown): void; delete(key: string): void } } };
    if (api.Highlight) api.CSS?.highlights?.set("tether-chat-pending", new api.Highlight(...ranges));
  }
  let markTimer: ReturnType<typeof setTimeout> | undefined;
  geometryObserver = new ResizeObserver(() => { clearTimeout(markTimer); markTimer = setTimeout(refreshMarks, 100); });
  const observer = new MutationObserver(records => {
    if (!records.some(r => !element(r.target).closest(ownSelector) && (r.type === "characterData" || [...r.addedNodes, ...r.removedNodes].some(n => !(n instanceof HTMLElement && n.matches(ownSelector)))))) return;
    clearTimeout(markTimer); markTimer = setTimeout(refreshMarks, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener("selectionchange", selectionChanged);
  document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", keydown, true); document.addEventListener("click", clickPassage);
  window.addEventListener("resize", resize); document.addEventListener("scroll", hideMenu, true);
  return { flush, render, refreshMarks, dispose() {
    stopped = true; collections.dispose(); observer.disconnect(); geometryObserver?.disconnect(); clearTimeout(markTimer); close(); clearMarks(); menu.remove(); style.remove();
    for (const p of panels.values()) p.node.remove();
    (globalThis as any).CSS?.highlights?.delete("tether-chat-pending");
    document.removeEventListener("selectionchange", selectionChanged); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", keydown, true); document.removeEventListener("click", clickPassage);
    window.removeEventListener("resize", resize); document.removeEventListener("scroll", hideMenu, true);
  } };
}
