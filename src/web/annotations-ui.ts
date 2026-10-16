import { locateEditorVisual, mapEditorVisualAnchor } from "./visual-blocks";
import { commentWindowCss } from "../shared/comment-window";
import { smoothScroll } from "./motion";
import { placeOverlay } from './overlay';
import { iconSvg } from "./icons";
import { renderCommentBody } from "./comment-body";
import { keepContentEndVisible, overlayScrollHeader } from "./scroll-geometry";
import { Plugin, PluginKey, Selection } from "@milkdown/kit/prose/state";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import {
  createAnchor as createLedgerAnchor,
  renderedTextProjection,
  resolveAnchor as resolveLedgerAnchor,
  type AnnotationAnchor as LedgerAnchor,
  type RenderedTextProjection,
} from "../core/annotation-ledger";

/**
 * The UI deliberately knows about the derived shape, not the append-only
 * ledger. The server/codec can reduce events to this shape before handing it
 * to the controller.
 */
/** UI consumers and the ledger share one anchor contract. */
export type AnnotationAnchor = LedgerAnchor;

export interface AnnotationReply {
  id: string;
  actor: string;
  createdAt: string;
  body: string;
  seq?: number;
}

export interface AnnotationThread {
  id: string;
  actor: string;
  createdAt: string;
  body: string;
  anchor: AnnotationAnchor;
  replies?: readonly AnnotationReply[];
  resolved?: boolean;
  /** A derived orphan flag is accepted, but the resolver also verifies it. */
  orphaned?: boolean;
  seq?: number;
  deleted?: boolean;
}

export interface DerivedAnnotationState {
  threads: readonly AnnotationThread[];
}

export interface CommentDraft {
  body: string;
  anchor: AnnotationAnchor;
}

export interface ReplyDraft {
  body: string;
  thread: AnnotationThread;
}

export interface AnnotationUiOptions {
  visualDrawer?: boolean;
  sizingControl?: HTMLElement;
  fileControl?: HTMLElement;
  /** Element into which the controller mounts its narrow rail. */
  root: HTMLElement;
  /** The rendered editor root, used for selecting anchors and footnotes. */
  editorRoot?: HTMLElement;
  onCreateComment?: (draft: CommentDraft) => void | Promise<void>;
  onReply?: (draft: ReplyDraft) => void | Promise<void>;
  onResolve?: (thread: AnnotationThread) => void | Promise<void>;
  onReopen?: (thread: AnnotationThread) => void | Promise<void>;
  onEdit?: (draft: { thread: AnnotationThread; targetId: string; body: string }) => void | Promise<void>;
  onDelete?: (draft: { thread: AnnotationThread; targetId: string }) => void | Promise<void>;
  onVisibleThreadsChange?: (threads: readonly AnnotationThread[]) => void;
  onPendingCountChange?: (count: number) => void;
  onRailOpenChange?: (open: boolean) => void;
  onReanchor?: (thread: AnnotationThread, anchor: AnnotationAnchor) => Promise<void>;
  onRedraw?: (thread: AnnotationThread) => void;
  onSelectThread?: (thread: AnnotationThread) => void;
  onNotice?: (message: string) => void;
  onExport?: () => void | Promise<void>;
  onCopyFilePath?: () => void | Promise<void>;
  /** Actor using this viewer; any other latest author hands the thread to them. */
  localActor?: string;
  /** Optional lazy lookup keeps the controller independent of app state. */
  getEditorView?: () => EditorView | null;
}

export interface AnnotationUiController {
  readonly plugin: ReturnType<typeof createAnnotationPlugin>;
  setState(state: DerivedAnnotationState): void;
  attachEditorView(view: EditorView): void;
  detachEditorView(view?: EditorView): void;
  openCommentComposer(anchor?: AnnotationAnchor): void;
  openThread(threadId: string, trigger?: HTMLElement): void;
  createVisualDrawer(root: HTMLElement, onOpenChange: (open: boolean) => void): AnnotationUiController;
  setRailOpen(open: boolean): void;
  isRailOpen(): boolean;
  closeFootnotePopover(): void;
  destroy(): void;
}

export type Projection = RenderedTextProjection;

export interface ResolvedAnchor {
  start: number;
  end: number;
  ranges: readonly { from: number; to: number }[];
}

export type ActorColor = "amber" | "blue" | "cyan" | "green" | "rose" | "violet";

const ACTOR_COLORS: readonly ActorColor[] = ["amber", "blue", "cyan", "green", "rose", "violet"];
const NOOP = (): void => undefined;
const UNKNOWN_BODY_REVISION = "sha256:" + "0".repeat(64);

/** Stable, non-authenticating visual identity for an asserted actor string. */
export function actorColor(actor: string): ActorColor {
  let hash = 2166136261;
  for (let index = 0; index < actor.length; index += 1) {
    hash ^= actor.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ACTOR_COLORS[(hash >>> 0) % ACTOR_COLORS.length];
}

/** Compatibility alias for callers that use the UI module as their projection entry point. */
export const projectDocument = renderedTextProjection;

function projectionRanges(
  projection: RenderedTextProjection,
  start: number,
  end: number,
): Array<{ from: number; to: number }> {
  const result: Array<{ from: number; to: number }> = [];
  for (const segment of projection.segments) {
    if (segment.kind !== "text") continue;
    const overlapStart = Math.max(start, segment.projectionStart);
    const overlapEnd = Math.min(end, segment.projectionEnd);
    if (overlapStart >= overlapEnd) continue;
    result.push({
      from: segment.from + overlapStart - segment.projectionStart,
      to: segment.from + overlapEnd - segment.projectionStart,
    });
  }
  return result;
}

// ProseMirror documents are immutable: a revision applies only to the snapshot
// loaded from disk or acknowledged by a completed save, never to later edits.
const documentRevisions = new WeakMap<ProseMirrorNode, string>();
export function registerDocumentRevision(doc: ProseMirrorNode, revision: string): void {
  documentRevisions.set(doc, revision);
}
const selectedRanges = new WeakMap<AnnotationAnchor, { doc: ProseMirrorNode; from: number; to: number } | null>();

function currentAnchor(doc: ProseMirrorNode, anchor: AnnotationAnchor): AnnotationAnchor | null {
  if (!selectedRanges.has(anchor)) return anchor;
  const range = selectedRanges.get(anchor);
  if (!range || range.doc !== doc) return null;
  return captureRange(doc, range.from, range.to, documentRevisions.get(doc) ?? UNKNOWN_BODY_REVISION);
}

/** Resolve using the canonical ledger resolver, then split cross-block quotes into inline runs. */
export function resolveAnchor(doc: ProseMirrorNode, anchor: AnnotationAnchor): ResolvedAnchor | null {
  if(anchor.visual){const block=locateEditorVisual(doc,anchor,documentRevisions.get(doc));return block?{start:block.start,end:block.end,ranges:[{from:block.from,to:block.to}]}:null;}
  const projection = renderedTextProjection(doc);
  const captured = currentAnchor(doc, anchor);
  if (!captured) return null;
  const resolution = selectedRanges.has(anchor)
    ? { status: "resolved" as const, projectionStart: captured.projectionStart, projectionEnd: captured.projectionEnd }
    : resolveLedgerAnchor(anchor, projection, documentRevisions.get(doc));
  if (resolution.status !== "resolved") return null;
  const ranges = projectionRanges(projection, resolution.projectionStart, resolution.projectionEnd);
  return ranges.length > 0
    ? { start: resolution.projectionStart, end: resolution.projectionEnd, ranges }
    : null;
}

/** Capture a selected editor range as a portable quote anchor. */
export function captureAnchor(view: EditorView, sourceBodyRevision = UNKNOWN_BODY_REVISION): AnnotationAnchor | null {
  const { from, to } = view.state.selection;
  return captureRange(view.state.doc, from, to, sourceBodyRevision);
}

export function captureRange(doc: ProseMirrorNode, from: number, to: number, sourceBodyRevision: string): AnnotationAnchor | null {
  if (from >= to) return null;
  const projection = projectDocument(doc);
  let start: number | null = null;
  let end: number | null = null;
  for (let offset = 0; offset < projection.positions.length - 1; offset += 1) {
    const position = projection.positions[offset];
    const nextPosition = projection.positions[offset + 1];
    if (position >= from && position < to && start === null) start = offset;
    if (position >= from && position < to && nextPosition !== undefined) end = offset + 1;
  }
  if (start === null || end === null || end <= start) return null;
  const anchor = createLedgerAnchor(projection, start, end, sourceBodyRevision);
  selectedRanges.set(anchor, { doc, from, to });
  return anchor;
}

function threadSort(a: AnnotationThread, b: AnnotationThread): number {
  const aStart = a.anchor.projectionStart ?? Number.POSITIVE_INFINITY;
  const bStart = b.anchor.projectionStart ?? Number.POSITIVE_INFINITY;
  return aStart - bStart
    || (a.seq ?? Number.POSITIVE_INFINITY) - (b.seq ?? Number.POSITIVE_INFINITY)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function latestMessage(thread: AnnotationThread): { actor: string; body: string } {
  return thread.replies?.at(-1) ?? thread;
}

function actorMatches(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/** Moves only misplaced children; a removed node loses its running transitions. */
function reconcileChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
  for (const child of [...parent.children]) if (!children.includes(child as HTMLElement)) child.remove();
  children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null); });
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.toggleAttribute("aria-busy", busy);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function createAnnotationPlugin(controller: AnnotationUiControllerLike): Plugin<AnnotationPluginState> {
  const plugin = new Plugin<AnnotationPluginState>({
    key: annotationUiPluginKey,
    state: {
      init: (_config, state) => ({ threads: [], draftAnchor: null, decorations: DecorationSet.create(state.doc, []) }),
      apply: (transaction, previous, _oldState, newState) => {
        const meta = transaction.getMeta(annotationUiPluginKey) as AnnotationPluginMeta | undefined;
        if (meta || transaction.docChanged) {
          const threads = meta?.threads ?? previous.threads;
          if(transaction.docChanged) for(const thread of threads) if(thread.anchor.visual) mapEditorVisualAnchor(thread.anchor,_oldState.doc,newState.doc,transaction.mapping);
          const draftAnchor = meta?.draftAnchor === undefined ? previous.draftAnchor : meta.draftAnchor;
          if (transaction.docChanged && draftAnchor && selectedRanges.has(draftAnchor)) {
            const range = selectedRanges.get(draftAnchor);
            if (range && range.doc === _oldState.doc) {
              const from = transaction.mapping.map(range.from, 1);
              const to = transaction.mapping.map(range.to, -1);
              selectedRanges.set(draftAnchor, from < to ? { doc: newState.doc, from, to } : null);
            }
          }
          return { threads, draftAnchor, decorations: createAnnotationDecorations(newState.doc, threads, draftAnchor) };
        }
        return previous;
      },
    },
    props: {
      decorations: (state) => annotationUiPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-wm-annotation-id]")
            : null;
          const threadId = target?.dataset.wmAnnotationId;
          if (!threadId) return false;
          controller.openThread(threadId, target);
          return true;
        },
      },
    },
  });
  return plugin;
}

interface AnnotationPluginState {
  threads: readonly AnnotationThread[];
  draftAnchor: AnnotationAnchor | null;
  decorations: DecorationSet;
}

interface AnnotationPluginMeta {
  threads: readonly AnnotationThread[];
  draftAnchor?: AnnotationAnchor | null;
}

interface AnnotationUiControllerLike {
  openThread(threadId: string, trigger?: HTMLElement): void;
}

export const annotationUiPluginKey = new PluginKey<AnnotationPluginState>("wave-markdown-annotations");

export function createAnnotationDecorations(
  doc: ProseMirrorNode,
  threads: readonly AnnotationThread[],
  draftAnchor: AnnotationAnchor | null = null,
): DecorationSet {
  const decorations: Decoration[] = [];
  if (draftAnchor) {
    for (const range of resolveAnchor(doc, draftAnchor)?.ranges ?? []) {
      decorations.push(Decoration.inline(range.from, range.to, {
        class: "wm-annotation-highlight",
      }, { draft: true }));
    }
  }
  const badges = new Map<number, { threadId: string; count: number }>();
  for (const thread of threads) {
    if (thread.orphaned || thread.deleted || thread.anchor.visual) continue;
    const resolved = resolveAnchor(doc, thread.anchor);
    if (!resolved) continue;
    const color = actorColor(thread.actor);
    const className = [
      "wm-annotation-highlight",
      `wm-annotation-${color}`,
      thread.resolved ? "wm-annotation-resolved" : "",
    ].filter(Boolean).join(" ");
    for (const range of resolved.ranges) {
      decorations.push(Decoration.inline(range.from, range.to, {
        class: className,
        "data-wm-annotation-id": thread.id,
        "data-wm-annotation-color": color,
      }, { annotationId: thread.id }));
    }
    const badgePosition = resolved.ranges.at(-1)?.to;
    if (badgePosition != null) {
      const existing = badges.get(badgePosition);
      badges.set(badgePosition, existing
        ? { threadId: existing.threadId, count: existing.count + 1 + (thread.replies?.length ?? 0) }
        : { threadId: thread.id, count: 1 + (thread.replies?.length ?? 0) });
    }
  }
  for (const [position, badge] of badges) {
    decorations.push(Decoration.widget(position, () => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-annotation-count";
      button.dataset.wmAnnotationId = badge.threadId;
      button.setAttribute("aria-label", `${badge.count} messages in thread`);
      button.textContent = String(badge.count);
      return button;
    }, { side: 1, key: `annotation-count-${position}-${badge.threadId}-${badge.count}` }));
  }
  return DecorationSet.create(doc, decorations);
}

type FootnoteReference = HTMLElement;

function readFootnoteLabel(reference: FootnoteReference): string {
  return reference.dataset.label
    || reference.dataset.footnoteLabel
    || reference.getAttribute("data-id")
    || reference.textContent?.trim().replace(/^\[\^|\]$/g, "")
    || "";
}

function findFootnoteDefinition(root: HTMLElement, label: string): HTMLElement | null {
  const definition = [...root.querySelectorAll<HTMLElement>('[data-type="footnote_definition"][data-label]')]
    .find(node => node.dataset.label?.toUpperCase() === label.toUpperCase());
  if (definition) return definition;
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(label)
    : label.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  return root.querySelector<HTMLElement>([
    `[data-type="footnote_definition"][data-label="${escaped}"]`,
    `[data-footnote-label="${escaped}"]`,
    `#fn-${escaped}`,
    `#footnote-${escaped}`,
  ].join(", "));
}

function showFootnotePopover(root: HTMLElement, reference: FootnoteReference, view: EditorView | null): HTMLElement | null {
  const label = readFootnoteLabel(reference);
  const definition = findFootnoteDefinition(root, label);
  if (!definition) return null;
  root.ownerDocument.querySelector(".wm-footnote-popover")?.remove();
  const popover = createElement("aside", "wm-footnote-popover");
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `Footnote ${reference.textContent?.trim() || "reference"}`);
  const heading = createElement("strong", "wm-footnote-label");
  heading.textContent = label ? `Footnote ${reference.textContent?.trim() || label}` : "Footnote";
  const body = createElement("div", "wm-footnote-body");
  const content = definition.querySelector(":scope > dd") ?? definition;
  const note = content.cloneNode(true) as HTMLElement;
  note.querySelectorAll(".wm-annotation-count, .ProseMirror-widget").forEach(element => element.remove());
  body.textContent = note.textContent?.trim() || "(Empty footnote)";
  const close = createElement("button", "wm-footnote-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close footnote");
  close.textContent = "×";
  close.addEventListener("click", () => popover.remove());
  popover.append(heading, close, body);
  if (view?.editable) {
    const actions = createElement("div", "wm-footnote-actions");
    const edit = createElement("button", "wm-comment-button");
    edit.type = "button";
    edit.title = "Edit footnote";
    edit.setAttribute("aria-label", "Edit footnote");
    edit.innerHTML = iconSvg("pencil-line");
    edit.addEventListener("click", () => {
      if (!view.editable) return;
      let position: number | undefined;
      view.state.doc.descendants((node, pos) => {
        if (position === undefined && node.type.name === "footnote_definition" && String(node.attrs.label).toUpperCase() === label.toUpperCase()) position = pos;
      });
      if (position === undefined) return;
      const selection = Selection.findFrom(view.state.doc.resolve(position + 1), 1, true);
      if (!selection) return;
      popover.remove();
      view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
      view.focus();
    });
    actions.append(edit);
    popover.append(actions);
  }
  root.ownerDocument.body.append(popover);
  placeOverlay(popover, { root, policy: 'follow', reference: () => reference.isConnected ? reference.getBoundingClientRect() : null });
  return popover;
}

export function createAnnotationUi(options: AnnotationUiOptions): AnnotationUiController {
  const {
    root,
    editorRoot,
    onCreateComment = NOOP,
    onReply = NOOP,
    onResolve = NOOP,
    onReopen = NOOP,
    onEdit = NOOP,
    onDelete = NOOP,
    onPendingCountChange = NOOP,
    onRailOpenChange = NOOP,
    onSelectThread = NOOP,
    onNotice = NOOP,
    getEditorView,
    localActor = "human",
  } = options;

  let state: DerivedAnnotationState = { threads: [] };
  let editorView: EditorView | null = null;
  let destroyed = false;
  let cancelReselect = () => {};
  let activeThreadId: string | null = null;
  let composer: HTMLElement | null = null;
  let composerAnchor: AnnotationAnchor | undefined;
  let threadPopover: HTMLElement | null = null;
  let railOpen = false;
  let showResolved = Boolean(options.visualDrawer);
  let batchResolving = false;
  const batchSelection = new Set<string>();
  const messageBodies = new WeakMap<HTMLElement, string>();
  const submittingMessages = new WeakMap<HTMLElement, string>();
  const cards = new Map<string, { card: HTMLElement; signature: string }>();
  let stopThreadScroll = () => {};
  let drawerAnimation: Animation | undefined;
  const threadAnimations = new Map<HTMLElement, Animation>();
  const rail = createElement("aside", "wm-annotation-rail");
  rail.setAttribute("aria-label", "Threads");
  root.append(rail);
  const content = createElement("div", "wm-annotation-rail-content");
  const scroller = createElement("div", "wm-annotation-rail-scroll");
  scroller.append(content);
  rail.append(scroller);
  const stopEndRecovery = keepContentEndVisible(content, scroller);
  // Cards keep their parents across renders so CSS transitions can run.
  const orphanGroup = createElement("section", "wm-orphan-group");
  const orphanHeading = createElement("h3");
  orphanHeading.textContent = "Orphaned threads";
  const railHeader = createRailHeader();
  rail.prepend(railHeader.header);
  const stopHeaderOverlay = overlayScrollHeader(scroller, railHeader.header);

  const controller: AnnotationUiController & AnnotationUiControllerLike = {
    plugin: undefined as unknown as ReturnType<typeof createAnnotationPlugin>,
    setState(nextState) {
      if (destroyed) return;
      const focused = rail.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      const previousOrder = [...content.querySelectorAll<HTMLElement>('[data-thread-id]')].map(card => card.dataset.threadId!);
      const previousIndex = activeThreadId ? previousOrder.indexOf(activeThreadId) : -1;
      state = { threads: [...nextState.threads] };
      const visible = new Set(visibleThreads().map(thread => thread.id));
      const removedActive = activeThreadId !== null && !visible.has(activeThreadId);
      let nextThreadId: string | undefined;
      if (removedActive) {
        nextThreadId = previousOrder.slice(previousIndex + 1).find(id => visible.has(id))
          ?? previousOrder.slice(0, previousIndex).reverse().find(id => visible.has(id));
        activeThreadId = null;
        threadPopover?.remove();
        threadPopover = null;
      }
      renderRail();
      if (focused?.isConnected && !focused.closest('[hidden],[inert]')) focused.focus({ preventScroll: true });
      if (removedActive || threadAnimations.size) updateExpansion(nextThreadId ?? activeThreadId ?? undefined);
      onPendingCountChange(attentionCount());
      syncDecorations();
      const active = activeThreadId && state.threads.find((thread) => thread.id === activeThreadId && !thread.deleted);
      // Refresh an explicitly opened popover; a selected thread is not an open request.
      if (active && threadPopover && !railOpen) showThreadPopover(active);
    },
    attachEditorView(view) {
      editorView = view;
      syncDecorations(view);
    },
    detachEditorView(view) {
      if (!view || editorView === view) editorView = null;
    },
    openCommentComposer(anchor) {
      if (destroyed) return;
      const view = currentView();
      const nextAnchor = anchor ?? (view ? captureAnchor(view) : null) ?? undefined;
      if (view && (!nextAnchor || !resolveAnchor(view.state.doc, nextAnchor))) {
        onNotice("Couldn’t locate the selected passage. Select it again before commenting.");
        return;
      }
      composer?.remove();
      composerAnchor = nextAnchor;
      // Supplied quote anchors also become a live range while composing.
      if (view && composerAnchor && !selectedRanges.has(composerAnchor)) {
        const ranges = resolveAnchor(view.state.doc, composerAnchor)!.ranges;
        selectedRanges.set(composerAnchor, { doc: view.state.doc, from: ranges[0].from, to: ranges.at(-1)!.to });
      }
      composer = createCommentComposer(composerAnchor);
      document.body.append(composer);
      syncDecorations();
      positionPopover(composer, composerAnchor);
      // Once placed, the new comment window stays where it is (or where it's dragged) while the page scrolls.
      placements.get(composer)?.(); placements.delete(composer);
      makeDraggable(composer);
      composer.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    },
    createVisualDrawer(drawerRoot, onOpenChange) {
      return createAnnotationUi({ ...options, root: drawerRoot, visualDrawer: true,
        editorRoot: undefined, getEditorView: undefined, sizingControl: undefined, fileControl: undefined,
        onVisibleThreadsChange: undefined, onPendingCountChange: undefined,
        onSelectThread: undefined, onRailOpenChange: onOpenChange });
    },
    openThread(threadId, trigger) {
      if (destroyed) return;
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      activeThreadId = threadId;
      threadPopover?.remove();
      threadPopover = null;
      updateExpansion(threadId);
      navigateToThread(thread, trigger);
      if (!railOpen) showThreadPopover(thread, trigger);
      onSelectThread(thread);
    },
    setRailOpen(open) {
      if (railOpen === open) return;
      if (!open) setBatchResolving(false);
      rail.ownerDocument.dispatchEvent(new rail.ownerDocument.defaultView!.Event("wm-before-rail-layout"));
      railOpen = open;
      threadPopover?.remove();
      threadPopover = null;
      renderRailVisibility(true);
      onRailOpenChange(open);
    },
    isRailOpen() {
      return railOpen;
    },
    closeFootnotePopover() {
      editorRoot?.ownerDocument.querySelector(".wm-footnote-popover")?.remove();
    },
    destroy() {
      cancelReselect();
      if (destroyed) return;
      destroyed = true;
      stopThreadScroll();
      drawerAnimation?.cancel();
      for (const animation of threadAnimations.values()) animation.cancel();
      stopEndRecovery();
      stopHeaderOverlay();
      editorRoot?.removeEventListener("click", handleEditorClick);
      editorRoot?.removeEventListener("keydown", handleFootnoteKeydown);
      editorRoot?.ownerDocument.querySelector(".wm-footnote-popover")?.remove();
      composer?.remove();
      composer = null;
      composerAnchor = undefined;
      syncDecorations();
      threadPopover?.remove();
      threadPopover = null;
      rail.remove();
      editorView = null;
    },
  };
  (controller as unknown as { plugin: ReturnType<typeof createAnnotationPlugin> }).plugin = createAnnotationPlugin(controller);

  function currentView(): EditorView | null {
    return getEditorView?.() ?? editorView;
  }

  function navigateToThread(thread: AnnotationThread, trigger?: HTMLElement): void {
    const view = currentView();
    if (!view) return;
    const highlight = trigger ?? [...view.dom.querySelectorAll<HTMLElement>("[data-wm-annotation-id]")]
      .find((element) => element.dataset.wmAnnotationId === thread.id);
    highlight?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  const placements = new WeakMap<HTMLElement, () => void>();
  function positionPopover(node: HTMLElement, anchor?: AnnotationAnchor, trigger?: HTMLElement): void {
    placements.get(node)?.();
    const reference = () => {
      if (trigger?.isConnected) return trigger.getBoundingClientRect();
      const view = currentView();
      if (!view) return null;
      const resolved = anchor ? resolveAnchor(view.state.doc, anchor) : null;
      if (anchor && !resolved) return null;
      const position = resolved?.ranges.at(-1)?.to ?? view.state.selection.to;
      return view.coordsAtPos(position);
    };
    placements.set(node, placeOverlay(node, { root: editorRoot, policy: 'pin', reference }));
    // The opening animation (motion.ts) grows from the edge nearest the passage.
    let ref = null; try { ref = reference(); } catch {}
    node.dataset.wmMenuOrigin = `left ${ref && node.getBoundingClientRect().top < ref.top ? 'bottom' : 'top'}`;
  }

  // Drag from anywhere on the window except its controls; it stays inside the viewport.
  function makeDraggable(node: HTMLElement): void {
    node.classList.add("wm-draggable");
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("textarea, input, button, a, select")) return;
      event.preventDefault();
      const start = node.getBoundingClientRect(), dx = event.clientX - start.left, dy = event.clientY - start.top;
      const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
      node.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        node.style.left = `${clamp(next.clientX - dx, window.innerWidth - start.width)}px`;
        node.style.top = `${clamp(next.clientY - dy, window.innerHeight - start.height)}px`;
      };
      const end = () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerup", end); node.removeEventListener("pointercancel", end); };
      node.addEventListener("pointermove", move); node.addEventListener("pointerup", end); node.addEventListener("pointercancel", end);
    });
  }

  function showThreadPopover(thread: AnnotationThread, trigger?: HTMLElement): void {
    threadPopover?.remove();
    threadPopover = null;
    // Visual comments live in the viewer, which owns their dismissal.
    if (thread.anchor.visual) return;
    const view = currentView();
    const orphaned = Boolean(thread.orphaned || (view && !resolveAnchor(view.state.doc, thread.anchor)));
    const details = renderThreadDetails(thread, orphaned);
    const popover = createElement("section", "wm-thread-popover");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `Comment by ${thread.actor}`);
    const close = createElement("button", "wm-footnote-close");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close comment");
    close.addEventListener("click", () => {
      popover.remove();
      threadPopover = null;
      activeThreadId = null;
      renderRail();
    });
    popover.append(close, details);
    document.body.append(popover);
    threadPopover = popover;
    positionPopover(popover, thread.anchor, trigger);
  }

  function createCommentComposer(anchor?: AnnotationAnchor): HTMLElement {
    if (!document.getElementById("tether-comment-window-style")) {
      const style = document.createElement("style"); style.id = "tether-comment-window-style"; style.textContent = commentWindowCss; document.head.append(style);
    }
    const section = createElement("section", "wm-annotation-composer wm-comment-popover tether-comment-window");
    section.setAttribute("aria-label", "Comment");
    const textarea = createElement("textarea", "wm-annotation-textarea");
    textarea.rows = 3;
    textarea.placeholder = "Comment...";
    textarea.setAttribute("aria-label", "Comment");
    const error = createElement("p", "wm-annotation-error");
    error.hidden = true;
    const actions = createElement("div", "wm-annotation-actions");
    const cancel = createElement("button", "wm-button wm-button-secondary");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const submit = createElement("button", "wm-button wm-button-primary");
    submit.type = "submit";
    submit.textContent = "Comment";
    actions.classList.add("tether-comment-actions");
    submit.dataset.primary = "";
    actions.append(cancel, submit);
    const form = createElement("form", "wm-annotation-form");
    form.append(textarea, error, actions);
    section.append(form);
    const close = () => {
      // An older in-flight save must not clear a newer composer's highlight.
      if (composer === section) {
        composer = null;
        composerAnchor = undefined;
        syncDecorations();
      }
      section.remove();
    };
    cancel.addEventListener("click", close);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = textarea.value;
      const view = currentView();
      const resolvedAnchor = anchor ? (view ? currentAnchor(view.state.doc, anchor) : anchor) : (view ? captureAnchor(view) : null);
      if (!resolvedAnchor) {
        error.textContent = "Couldn’t locate the selected passage. Close this comment and select it again.";
        error.hidden = false;
        return;
      }
      if (!body.trim()) {
        error.textContent = "A comment cannot be empty.";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      setBusy(submit, true);
      const submittedSelection = view?.state.selection;
      Promise.resolve(onCreateComment({ body, anchor: resolvedAnchor })).then(() => {
        // Checkbox toggles refocus the editor without moving its selection.
        // Retire the submitted range, but preserve any newer user selection.
        if (composer === section && view && !view.isDestroyed && currentView() === view &&
            submittedSelection && !submittedSelection.empty && view.state.selection.eq(submittedSelection)) {
          view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(view.state.selection.to))));
        }
        close();
      }).catch((reason: unknown) => {
        setBusy(submit, false);
        error.textContent = reason instanceof Error ? reason.message : "Comment could not be created.";
        error.hidden = false;
      });
    });
    return section;
  }

  function replyForm(thread: AnnotationThread): HTMLElement {
    const form = createElement("form", "wm-annotation-reply-form");
    const textarea = createElement("textarea", "wm-annotation-textarea");
    textarea.rows = 2;
    textarea.placeholder = "Reply…";
    textarea.setAttribute("aria-label", `Reply to ${thread.actor}`);
    const error = createElement("p", "wm-annotation-error");
    error.hidden = true;
    const actions = createElement("div", "wm-annotation-actions");
    const submit = createElement("button", "wm-button wm-button-primary");
    submit.type = "submit";
    submit.textContent = "Reply";
    actions.append(submit);
    form.append(textarea, error, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = textarea.value;
      if (!body.trim()) {
        error.textContent = "A reply cannot be empty.";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      setBusy(submit, true);
      Promise.resolve(onReply({ body, thread })).then(() => {
        if (textarea.value === body) textarea.value = "";
        setBusy(submit, false);
      }).catch((reason: unknown) => {
        setBusy(submit, false);
        error.textContent = reason instanceof Error ? reason.message : "Reply could not be sent.";
        error.hidden = false;
      });
    });
    return form;
  }

  function editableAnnotation(thread: AnnotationThread, targetId: string, value: string, className: string, actor: string, createdAt: string, includeDate: boolean): HTMLElement {
    const container = createElement("div", "wm-editable-annotation");
    container.dataset.messageId = targetId;
    messageBodies.set(container, value);
    container.classList.toggle("is-assistant", actorMatches(actor, "assistant"));
    const header = createElement("header", "wm-message-header");
    const author = createElement("span", "wm-message-author");
    author.textContent = actor;
    const meta = createElement("time", "wm-thread-time");
    meta.dateTime = createdAt;
    meta.title = formatTimestamp(createdAt);
    meta.setAttribute("aria-label", meta.title);
    const date = new Date(createdAt);
    meta.textContent = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, includeDate
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { hour: "numeric", minute: "2-digit" }).format(date)
      : createdAt;
    header.append(author, meta);
    const body = renderCommentBody(value);
    body.className = className;
    const edit = createElement("button", "wm-inline-edit");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", targetId === thread.id ? "Edit comment" : "Edit reply");
    header.append(edit);
    edit.addEventListener("click", () => {
      const textarea = createElement("textarea", "wm-annotation-textarea");
      textarea.value = value;
      textarea.setAttribute("aria-label", targetId === thread.id ? "Edit comment text" : "Edit reply text");
      textarea.rows = 3;
      const actions = createElement("div", "wm-annotation-actions");
      const remove = createElement("button", "wm-button wm-button-danger");
      remove.type = "button";
      remove.textContent = "Delete";
      const cancel = createElement("button", "wm-button wm-button-secondary");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const save = createElement("button", "wm-button wm-button-primary");
      save.type = "button";
      save.textContent = "Save";
      actions.append(remove, cancel, save);
      container.replaceChildren(textarea, actions);
      textarea.focus();
      cancel.addEventListener("click", () => container.replaceChildren(header, body));
      save.addEventListener("click", () => {
        const next = textarea.value;
        if (!next.trim()) { textarea.focus(); return; }
        setBusy(save, true);
        submittingMessages.set(container, next);
        Promise.resolve(onEdit({ thread, targetId, body: next })).catch((reason: unknown) => {
          submittingMessages.delete(container);
          setBusy(save, false);
          onNotice(reason instanceof Error ? reason.message : "Comment could not be edited.");
        });
      });
      remove.addEventListener("click", () => {
        setBusy(remove, true);
        Promise.resolve(onDelete({ thread, targetId }))
          .then(() => {
            threadPopover?.remove();
            threadPopover = null;
            activeThreadId = null;
            renderRail();
          })
          .catch((reason: unknown) => {
            setBusy(remove, false);
            onNotice(reason instanceof Error ? reason.message : "Comment could not be deleted.");
          });
      });
    });
    container.append(header, body);
    return container;
  }

  function renderThreadDetails(thread: AnnotationThread, orphaned: boolean): HTMLElement {
    const details = createElement("div", "wm-thread-details");
    if (thread.anchor.visual) {
      // Region controls belong to the visual viewer, not the conversation.
    } else if (orphaned && options.onReanchor) {
      const button=createElement('button','wm-button');button.textContent='Reselect text';let abort:AbortController|undefined;
      const cancel=()=>{abort?.abort();abort=undefined;editorRoot?.classList.remove('wm-reselecting');button.textContent='Reselect text';button.classList.remove('is-active');button.setAttribute('aria-pressed','false');};
      button.onclick=()=>{
        if(abort){cancel();return;}cancelReselect();cancelReselect=cancel;abort=new AbortController();const signal=abort.signal;
        button.textContent='Reselect text · [esc] to cancel';button.classList.add('is-active');button.setAttribute('aria-pressed','true');editorRoot?.classList.add('wm-reselecting');
        document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}},{signal,capture:true});
        editorRoot?.addEventListener('pointerup',()=>{setTimeout(()=>{const view=currentView();const anchor=view?captureAnchor(view):null;if(!anchor||signal.aborted)return;button.disabled=true;options.onReanchor!(thread,anchor).then(cancel).catch(e=>onNotice((e as Error).message)).finally(()=>{button.disabled=false;});},0);},{signal});
      };details.append(button);
    }
    const quote = createElement("blockquote", "wm-thread-quote");
    quote.textContent = thread.anchor.visual ? `${thread.anchor.visual.kind} region` : thread.anchor.exact || "(No quoted passage)";
    if (!thread.anchor.visual && thread.anchor.exact.length > 180) {
      const context = createElement("details", "wm-thread-context");
      const summary = createElement("summary");
      summary.textContent = `${thread.anchor.exact.slice(0, 160)}…`;
      summary.title = "Expand quoted passage";
      context.append(summary, quote);
      details.append(context);
    } else if (!thread.anchor.visual) details.append(quote);
    details.append(editableAnnotation(thread, thread.id, thread.body, "wm-thread-body", thread.actor, thread.createdAt, true));
    const replies = createElement("div", "wm-thread-replies");
    let previousDate = new Date(thread.createdAt).toDateString();
    for (const reply of thread.replies ?? []) {
      const item = createElement("article", "wm-thread-reply");
      const date = new Date(reply.createdAt).toDateString();
      item.append(editableAnnotation(thread, reply.id, reply.body, "wm-thread-body", reply.actor, reply.createdAt, date !== previousDate));
      previousDate = date;
      replies.append(item);
    }
    details.append(replies);
    const form = replyForm(thread);
    details.append(form);
    const stateButton = createElement("button", "wm-button wm-button-secondary");
    stateButton.type = "button";
    stateButton.textContent = thread.resolved ? "Reopen" : "Resolve";
    stateButton.addEventListener("click", () => {
      const callback = thread.resolved ? onReopen : onResolve;
      Promise.resolve(callback(thread)).catch((reason: unknown) => {
        onNotice(reason instanceof Error ? reason.message : "Comment state could not be changed.");
      });
    });
    form.querySelector(".wm-annotation-actions")!.prepend(stateButton);
    return details;
  }

  function needsUserAttention(thread: AnnotationThread): boolean {
    return !thread.resolved && !thread.deleted && !actorMatches(latestMessage(thread).actor, localActor);
  }

  function attentionCount(): number {
    return state.threads.filter(needsUserAttention).length;
  }

  function visibleThreads(): AnnotationThread[] {
    return state.threads.filter((thread) => !thread.deleted && (showResolved || !thread.resolved));
  }

  function syncDecorations(view = currentView()): void {
    options.onVisibleThreadsChange?.(visibleThreads());
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(annotationUiPluginKey, {
      threads: visibleThreads(), draftAnchor: composerAnchor ?? null,
    } satisfies AnnotationPluginMeta));
  }

  function renderThread(thread: AnnotationThread, orphaned: boolean): HTMLElement {
    const signature = JSON.stringify([thread, orphaned]);
    const cached = cards.get(thread.id);
    if (cached?.signature === signature) return cached.card;
    const latest = latestMessage(thread);
    const card = createElement("article", "wm-thread-card");
    card.dataset.threadId = thread.id;
    card.dataset.lastAssistant = String(actorMatches(latest.actor, "assistant"));
    if (thread.id === activeThreadId) card.classList.add("is-active");
    if (orphaned) card.classList.add("is-orphaned");
    if (thread.resolved) card.classList.add("is-resolved");
    const summary = createElement("button", "wm-thread-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", String(thread.id === activeThreadId));
    summary.setAttribute("aria-label", `Open thread started by ${thread.actor}`);
    const identity = createElement("span", "wm-thread-identity");
    const dot = createElement("span", "wm-actor-dot");
    dot.setAttribute("aria-hidden", "true");
    const actor = createElement("span", "wm-thread-actor");
    actor.textContent = latest.actor;
    identity.append(dot, actor);
    const labels = createElement("span", "wm-thread-labels");
    const status = createElement("span", "wm-thread-status");
    status.textContent = thread.resolved ? "Resolved" : "Open";
    labels.append(status);
    if (orphaned) {
      const location = createElement("span", "wm-thread-location");
      location.textContent = "Orphaned";
      labels.append(location);
    }
    const excerpt = createElement("span", "wm-thread-excerpt");
    excerpt.textContent = latest.body;
    const count = createElement("span", "wm-thread-count");
    const replyCount = thread.replies?.length ?? 0;
    count.textContent = replyCount ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Comment";
    const expandedTitle = createElement("span", "wm-thread-expanded-title");
    expandedTitle.textContent = "Conversation";
    labels.append(count);
    summary.append(identity, expandedTitle, labels, excerpt);
    if (!thread.resolved) {
      const select = createElement("input", "wm-thread-select");
      select.type = "checkbox";
      select.checked = batchSelection.has(thread.id);
      select.setAttribute("aria-label", `Select thread started by ${thread.actor}`);
      select.addEventListener("change", () => {
        if (select.checked) batchSelection.add(thread.id); else batchSelection.delete(thread.id);
        renderRail();
      });
      card.append(select);
    }
    card.append(summary);

    const details = renderThreadDetails(thread, orphaned);
    details.hidden = thread.id !== activeThreadId;
    card.append(details);
    summary.addEventListener("click", () => {
      if (activeThreadId === thread.id) {
        threadPopover?.remove();
        threadPopover = null;
        activeThreadId = null;
        updateExpansion();
      } else controller.openThread(thread.id);
    });
    if (cached) {
      // Preserve the live reply form and active edit controls across remote updates.
      const form = cached.card.querySelector('.wm-annotation-reply-form');
      if (form) {
        const nextForm = card.querySelector('.wm-annotation-reply-form');
        const stateButton = nextForm?.querySelector('.wm-button-secondary');
        if (stateButton) form.querySelector('.wm-button-secondary')?.replaceWith(stateButton);
        nextForm?.replaceWith(form);
      }
      for (const editor of cached.card.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const replacement = [...card.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === editor.dataset.messageId);
        if (!replacement) continue;
        const nextBody = messageBodies.get(replacement);
        if (submittingMessages.has(editor) && submittingMessages.get(editor) === nextBody) continue;
        if (editor.querySelector('textarea') || messageBodies.get(editor) === nextBody) replacement.replaceWith(editor);
      }
      cached.card.className = card.className;
      cached.card.dataset.lastAssistant = card.dataset.lastAssistant;
      cached.card.replaceChildren(...card.childNodes);
      cards.set(thread.id, { card: cached.card, signature });
      return cached.card;
    }
    cards.set(thread.id, { card, signature });
    return card;
  }

  function setBatchResolving(on: boolean): void {
    if (batchResolving === on) return;
    batchResolving = on;
    batchSelection.clear();
    rail.classList.toggle("is-batch", on);
    renderRail();
  }

  async function resolveSelectedThreads(): Promise<void> {
    const selected = state.threads.filter(thread => batchSelection.has(thread.id));
    setBatchResolving(false);
    for (const thread of selected) await onResolve(thread);
  }

  function updateExpansion(alignId?: string): void {
    stopThreadScroll();
    const before = new Map([...cards.values()].map(({ card }) => [card, card.getBoundingClientRect().height]));
    for (const animation of threadAnimations.values()) animation.cancel();
    threadAnimations.clear();
    for (const [id, { card }] of cards) {
      const expanded = id === activeThreadId;
      card.classList.toggle('is-active', expanded);
      card.querySelector('.wm-thread-summary')?.setAttribute('aria-expanded', String(expanded));
      const details = card.querySelector<HTMLElement>('.wm-thread-details')!;
      if (!expanded && details.contains(document.activeElement)) card.querySelector<HTMLButtonElement>('.wm-thread-summary')?.focus({ preventScroll: true });
      details.inert = !expanded;
      details.hidden = !expanded;
    }
    // A trailing runway permits even the last card to align below the header.
    // Retain it while that card stays anchored, including after collapse.
    scroller.style.paddingBottom = `${Math.max(28, scroller.clientHeight - 80)}px`;
    const alignedCard = alignId ? cards.get(alignId)?.card : undefined;
    const viewportTop = Math.max(scroller.getBoundingClientRect().top, rail.querySelector('.wm-annotation-rail-header')?.getBoundingClientRect().bottom ?? 0) + 12;
    const destination = alignedCard ? scroller.scrollTop + alignedCard.getBoundingClientRect().top - viewportTop : undefined;
    if (!(rail.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true)) {
      for (const { card } of cards.values()) {
        const from = before.get(card) ?? 0, to = card.getBoundingClientRect().height;
        if (!card.isConnected || Math.abs(from - to) < 1 || !card.animate) continue;
        const details = card.querySelector<HTMLElement>('.wm-thread-details')!;
        const collapsed = card.dataset.threadId !== activeThreadId;
        // Keep exiting content painted while the measured card clips it away.
        if (collapsed) details.hidden = false;
        const animation = card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 200, easing: 'ease-out' });
        threadAnimations.set(card, animation);
        animation.onfinish = () => { if (threadAnimations.get(card) !== animation) return; threadAnimations.delete(card); details.hidden = collapsed; };
      }
    }
    if (destination !== undefined && railOpen && scroller.getClientRects().length) stopThreadScroll = smoothScroll(scroller, destination);
  }

  function renderRailVisibility(animate = false): void {
    const wasHidden = rail.hidden;
    const fromTransform = wasHidden ? 'translateX(100%)' : getComputedStyle(rail).transform;
    const fromOpacity = wasHidden ? '0' : getComputedStyle(rail).opacity;
    drawerAnimation?.cancel();
    rail.dataset.open = String(railOpen);
    rail.inert = !railOpen;
    if (!railOpen && rail.contains(document.activeElement)) (options.visualDrawer ? root.closest('dialog')?.querySelector<HTMLElement>('.wm-diagram-viewport') : document.querySelector<HTMLElement>('#comment'))?.focus({ preventScroll: true });
    if (!animate || (rail.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true) || !rail.animate) { rail.hidden = !railOpen; return; }
    rail.hidden = false;
    drawerAnimation = rail.animate([{ transform: fromTransform, opacity: fromOpacity }, { transform: railOpen ? 'translateX(0)' : 'translateX(100%)', opacity: railOpen ? 1 : 0 }], { duration: 200, easing: 'ease-out' });
    drawerAnimation.onfinish = () => { rail.hidden = !railOpen; drawerAnimation = undefined; };
  }

  function createRailHeader() {
    const header = createElement("header", "wm-annotation-rail-header");
    const heading = createElement("div", "wm-rail-heading");
    const selectAll = createElement("input", "wm-thread-select wm-select-all");
    selectAll.type = "checkbox";
    selectAll.setAttribute("aria-label", "Select all threads");
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) for (const id of selectAll.dataset.ids?.split(" ").filter(Boolean) ?? []) batchSelection.add(id);
      else batchSelection.clear();
      renderRail();
    });
    const title = createElement("h2");
    title.textContent = "Threads";
    heading.append(selectAll, title);
    const badge = createElement("button", "wm-pending-badge");
    badge.type = "button";
    badge.addEventListener("click", () => {
      if (!batchResolving) { setBatchResolving(true); return; }
      resolveSelectedThreads().catch((reason: unknown) => {
        onNotice(reason instanceof Error ? reason.message : "Threads could not be resolved.");
      });
    });
    const filter = createElement("button", "wm-rail-button wm-unresolved-filter");
    filter.type = "button";
    filter.title = "Show resolved";
    filter.setAttribute("aria-label", "Show resolved");
    filter.innerHTML = iconSvg("square-check");
    filter.addEventListener("click", () => { showResolved = !showResolved; renderRail(); syncDecorations(); });
    const controls = createElement("div", "wm-annotation-rail-controls");
    if (options.sizingControl) controls.append(options.sizingControl);
    if (options.fileControl) controls.append(options.fileControl);
    const hide = createElement("button", "wm-hide-threads");
    hide.type = "button";
    hide.title = "Hide threads";
    hide.setAttribute("aria-label", "Hide threads");
    hide.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h10m-4-4 4 4-4 4m7-10v12"/></svg>';
    hide.addEventListener("click", () => controller.setRailOpen(false));
    controls.append(filter);
    if (options.onExport) {
      const exportButton = createElement("button", "wm-rail-button");
      exportButton.id = "export-review";
      exportButton.type = "button";
      exportButton.title = "Export with annotations";
      exportButton.setAttribute("aria-label", "Export with annotations");
      exportButton.innerHTML = iconSvg("file-down");
      exportButton.addEventListener("click", () => { void options.onExport!(); });
      controls.append(exportButton);
    }
    if (options.onCopyFilePath) {
      const copyPath = createElement("button", "wm-rail-button");
      copyPath.type = "button";
      copyPath.title = "Copy file path";
      copyPath.setAttribute("aria-label", "Copy file path");
      copyPath.innerHTML = iconSvg("route");
      copyPath.addEventListener("click", () => { void options.onCopyFilePath!(); });
      controls.append(copyPath);
    }
    controls.append(hide);
    header.append(heading, controls, badge);
    if (options.visualDrawer) header.replaceChildren(hide);
    return { header, selectAll, badge, filter };
  }

  /** Updates the persistent header in place so its transitions can run. */
  function renderRailHeader(selectableIds: readonly string[]): void {
    const { selectAll, badge, filter } = railHeader;
    const selected = selectableIds.filter(id => batchSelection.has(id)).length;
    selectAll.dataset.ids = selectableIds.join(" ");
    selectAll.checked = selected > 0 && selected === selectableIds.length;
    selectAll.indeterminate = selected > 0 && selected < selectableIds.length;
    selectAll.disabled = !selectableIds.length;
    for (const select of content.querySelectorAll<HTMLInputElement>(".wm-thread-card > .wm-thread-select")) {
      select.checked = batchSelection.has(select.closest<HTMLElement>(".wm-thread-card")!.dataset.threadId!);
    }
    const pending = attentionCount();
    if (batchResolving) {
      badge.textContent = `Resolve ${batchSelection.size} ${batchSelection.size === 1 ? "thread" : "threads"}`;
      badge.removeAttribute("title");
      badge.setAttribute("aria-label", badge.textContent);
    } else {
      badge.textContent = `${pending} ${pending === 1 ? "needs" : "need"} attention`;
      badge.title = "Select threads to resolve";
      badge.setAttribute("aria-label", `${pending} open ${pending === 1 ? "thread needs" : "threads need"} your attention`);
    }
    badge.hidden = !batchResolving && pending === 0;
    filter.setAttribute("aria-pressed", String(showResolved));
  }

  function renderRail(): void {
    const nextContent: HTMLElement[] = [];
    const allThreads = state.threads.filter((thread) => !thread.deleted);
    const threads = visibleThreads().sort(threadSort);
    const view = currentView();
    const resolved = new Map<string, boolean>();
    for (const thread of threads) {
      // A rail can render before Milkdown has mounted. Only classify by
      // resolver when a view exists; the decoration plugin will resolve again
      // once the host attaches it.
      resolved.set(thread.id, Boolean(thread.orphaned || (view && !resolveAnchor(view.state.doc, thread.anchor))));
    }
    const validThreads = threads.filter((thread) => !resolved.get(thread.id));
    const orphanedThreads = threads.filter((thread) => resolved.get(thread.id));
    for (const id of batchSelection) if (!threads.some(thread => thread.id === id && !thread.resolved)) batchSelection.delete(id);
    if (threads.length === 0) {
      const empty = createElement("p", "wm-empty-comments");
      empty.textContent = allThreads.length ? "No open threads." : "No threads.";
      nextContent.push(empty);
    }
    for (const thread of validThreads) nextContent.push(renderThread(thread, false));
    if (orphanedThreads.length > 0) {
      reconcileChildren(orphanGroup, [orphanHeading, ...orphanedThreads.map(thread => renderThread(thread, true))]);
      nextContent.push(orphanGroup);
    }
    reconcileChildren(content, nextContent);
    renderRailHeader(threads.filter(thread => !thread.resolved).map(thread => thread.id));
    for (const id of cards.keys()) if (!threads.some(thread => thread.id === id)) cards.delete(id);
    renderRailVisibility();
  }

  function handleEditorClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const handle = event.target.closest<HTMLElement>('dl[data-type="footnote_definition"] > dt');
    if (handle && editorRoot) {
      const label = handle.parentElement?.dataset.label?.toUpperCase();
      const reference = [...editorRoot.querySelectorAll<HTMLElement>('sup[data-type="footnote_reference"]')]
        .find(node => node.dataset.label?.toUpperCase() === label);
      if (reference) {
        event.preventDefault();
        reference.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
      }
      return;
    }
    const reference = event.target.closest<HTMLElement>([
      'sup[data-type="footnote_reference"]',
      "[data-footnote-reference]",
      "sup.footnote-reference",
    ].join(", "));
    if (!reference || !editorRoot) return;
    event.preventDefault();
    showFootnotePopover(editorRoot, reference, currentView());
  }

  function handleFootnoteKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || !(event.target instanceof Element) || !event.target.matches('dl[data-type="footnote_definition"] > dt')) return;
    handleEditorClick(event);
  }

  editorRoot?.addEventListener("click", handleEditorClick);
  editorRoot?.addEventListener("keydown", handleFootnoteKeydown);
  renderRail();
  onPendingCountChange(0);
  return controller;
}
