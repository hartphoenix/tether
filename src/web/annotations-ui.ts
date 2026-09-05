import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
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
  onPendingCountChange?: (count: number) => void;
  onRailOpenChange?: (open: boolean) => void;
  onSelectThread?: (thread: AnnotationThread) => void;
  onNotice?: (message: string) => void;
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
  setRailOpen(open: boolean): void;
  isRailOpen(): boolean;
  setZoom(scale: number): void;
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

/** Resolve using the canonical ledger resolver, then split cross-block quotes into inline runs. */
export function resolveAnchor(doc: ProseMirrorNode, anchor: AnnotationAnchor): ResolvedAnchor | null {
  const projection = renderedTextProjection(doc);
  const resolution = resolveLedgerAnchor(anchor, projection);
  if (resolution.status !== "resolved") return null;
  const ranges = projectionRanges(projection, resolution.projectionStart, resolution.projectionEnd);
  return ranges.length > 0
    ? { start: resolution.projectionStart, end: resolution.projectionEnd, ranges }
    : null;
}

/** Capture a selected editor range as a portable quote anchor. */
export function captureAnchor(view: EditorView, sourceBodyRevision = UNKNOWN_BODY_REVISION): AnnotationAnchor | null {
  const { from, to } = view.state.selection;
  if (from >= to) return null;
  const projection = projectDocument(view.state.doc);
  let start: number | null = null;
  let end: number | null = null;
  for (let offset = 0; offset < projection.positions.length - 1; offset += 1) {
    const position = projection.positions[offset];
    const nextPosition = projection.positions[offset + 1];
    if (position >= from && position < to && start === null) start = offset;
    if (position >= from && position < to && nextPosition !== undefined) end = offset + 1;
  }
  if (start === null || end === null || end <= start) return null;
  return createLedgerAnchor(projection, start, end, sourceBodyRevision);
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
      init: (_config, state) => ({ threads: [], decorations: DecorationSet.create(state.doc, []) }),
      apply: (transaction, previous, _oldState, newState) => {
        const meta = transaction.getMeta(annotationUiPluginKey) as AnnotationPluginMeta | undefined;
        if (meta?.threads) return { threads: meta.threads, decorations: createAnnotationDecorations(newState.doc, meta.threads) };
        if (transaction.docChanged) {
          return { threads: previous.threads, decorations: createAnnotationDecorations(newState.doc, previous.threads) };
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
  decorations: DecorationSet;
}

interface AnnotationPluginMeta {
  threads: readonly AnnotationThread[];
}

interface AnnotationUiControllerLike {
  openThread(threadId: string, trigger?: HTMLElement): void;
}

export const annotationUiPluginKey = new PluginKey<AnnotationPluginState>("wave-markdown-annotations");

export function createAnnotationDecorations(
  doc: ProseMirrorNode,
  threads: readonly AnnotationThread[],
): DecorationSet {
  const decorations: Decoration[] = [];
  const badges = new Map<number, { threadId: string; count: number }>();
  for (const thread of threads) {
    if (thread.orphaned || thread.deleted) continue;
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

function showFootnotePopover(root: HTMLElement, reference: FootnoteReference): HTMLElement | null {
  const label = readFootnoteLabel(reference);
  const definition = findFootnoteDefinition(root, label);
  if (!definition) return null;
  root.querySelector(".wm-footnote-popover")?.remove();
  const popover = createElement("aside", "wm-footnote-popover");
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `Footnote ${label || "reference"}`);
  const heading = createElement("strong", "wm-footnote-label");
  heading.textContent = label ? `Footnote ${label}` : "Footnote";
  const body = createElement("div", "wm-footnote-body");
  body.textContent = definition.textContent?.trim() || "(Empty footnote)";
  const close = createElement("button", "wm-footnote-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close footnote");
  close.textContent = "×";
  close.addEventListener("click", () => popover.remove());
  popover.append(heading, close, body);
  root.append(popover);
  const referenceRect = reference.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  popover.style.left = `${Math.max(8, referenceRect.left - rootRect.left)}px`;
  popover.style.top = `${Math.max(8, referenceRect.bottom - rootRect.top + 8)}px`;
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
    localActor = "hart",
  } = options;

  let state: DerivedAnnotationState = { threads: [] };
  let editorView: EditorView | null = null;
  let destroyed = false;
  let activeThreadId: string | null = null;
  let composer: HTMLElement | null = null;
  let composerAnchor: AnnotationAnchor | undefined;
  let threadPopover: HTMLElement | null = null;
  let railOpen = false;
  let showResolved = false;
  let annotationZoom = 1;
  const rail = createElement("aside", "wm-annotation-rail");
  rail.setAttribute("aria-label", "Threads");
  root.append(rail);

  const controller: AnnotationUiController & AnnotationUiControllerLike = {
    plugin: undefined as unknown as ReturnType<typeof createAnnotationPlugin>,
    setState(nextState) {
      if (destroyed) return;
      state = { threads: [...nextState.threads] };
      renderRail();
      onPendingCountChange(attentionCount());
      const view = getEditorView?.() ?? editorView;
      if (view) {
        view.dispatch(view.state.tr.setMeta(annotationUiPluginKey, { threads: visibleThreads() } satisfies AnnotationPluginMeta));
      }
      const active = activeThreadId && state.threads.find((thread) => thread.id === activeThreadId && !thread.deleted);
      if (active && !railOpen) showThreadPopover(active);
    },
    attachEditorView(view) {
      editorView = view;
      view.dispatch(view.state.tr.setMeta(annotationUiPluginKey, { threads: visibleThreads() } satisfies AnnotationPluginMeta));
    },
    detachEditorView(view) {
      if (!view || editorView === view) editorView = null;
    },
    openCommentComposer(anchor) {
      if (destroyed) return;
      composer?.remove();
      composerAnchor = anchor;
      composer = createCommentComposer(anchor);
      applyZoom(composer);
      document.body.append(composer);
      positionPopover(composer, anchor);
      composer.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    },
    openThread(threadId, trigger) {
      if (destroyed) return;
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      activeThreadId = threadId;
      threadPopover?.remove();
      threadPopover = null;
      renderRail();
      navigateToThread(thread, trigger);
      if (!railOpen) showThreadPopover(thread, trigger);
      onSelectThread(thread);
    },
    setRailOpen(open) {
      railOpen = open;
      threadPopover?.remove();
      threadPopover = null;
      renderRail();
      onRailOpenChange(open);
    },
    isRailOpen() {
      return railOpen;
    },
    setZoom(scale) {
      if (!Number.isFinite(scale) || scale <= 0) return;
      annotationZoom = scale;
      applyZoom(rail);
      if (composer) {
        applyZoom(composer);
        positionPopover(composer, composerAnchor);
      }
      if (threadPopover) {
        applyZoom(threadPopover);
        const thread = activeThreadId ? state.threads.find((candidate) => candidate.id === activeThreadId) : undefined;
        positionPopover(threadPopover, thread?.anchor);
      }
    },
    closeFootnotePopover() {
      editorRoot?.querySelector(".wm-footnote-popover")?.remove();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      editorRoot?.removeEventListener("click", handleEditorClick);
      editorRoot?.querySelector(".wm-footnote-popover")?.remove();
      composer?.remove();
      composer = null;
      composerAnchor = undefined;
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

  function applyZoom(node: HTMLElement): void {
    node.style.setProperty("--wm-annotation-zoom", String(annotationZoom));
  }

  function navigateToThread(thread: AnnotationThread, trigger?: HTMLElement): void {
    const view = currentView();
    if (!view) return;
    const highlight = trigger ?? [...view.dom.querySelectorAll<HTMLElement>("[data-wm-annotation-id]")]
      .find((element) => element.dataset.wmAnnotationId === thread.id);
    highlight?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  function positionPopover(node: HTMLElement, anchor?: AnnotationAnchor, trigger?: HTMLElement): void {
    const view = currentView();
    const resolved = view && anchor ? resolveAnchor(view.state.doc, anchor) : null;
    const position = resolved?.ranges.at(-1)?.to ?? view?.state.selection.to;
    const canvasRect = editorRoot?.getBoundingClientRect();
    const hasCanvasBounds = Boolean(canvasRect && canvasRect.width > 0 && canvasRect.height > 0);
    const bounds = {
      left: Math.max(12, hasCanvasBounds ? canvasRect!.left + 12 : 12),
      top: Math.max(12, hasCanvasBounds ? canvasRect!.top + 12 : 12),
      right: Math.min(window.innerWidth - 12, hasCanvasBounds ? canvasRect!.right - 12 : window.innerWidth - 12),
      bottom: Math.min(window.innerHeight - 12, hasCanvasBounds ? canvasRect!.bottom - 12 : window.innerHeight - 12),
    };
    let reference: { left: number; right: number; top: number; bottom: number } | undefined = trigger?.getBoundingClientRect();
    if (!reference && view && position != null) {
      try {
        const coordinates = view.coordsAtPos(position);
        reference = coordinates;
      } catch {}
    }
    const availableWidth = Math.max(0, bounds.right - bounds.left);
    const availableHeight = Math.max(0, bounds.bottom - bounds.top);
    const localWidth = Math.min(340, availableWidth / annotationZoom);
    const localMaxHeight = Math.min(560, availableHeight / annotationZoom);
    node.style.width = `${localWidth}px`;
    node.style.maxHeight = `${localMaxHeight}px`;
    const box = node.getBoundingClientRect();
    const width = box.width || localWidth * annotationZoom;
    const height = box.height || localMaxHeight * annotationZoom;
    let left = reference?.left ?? bounds.left;
    let top = (reference?.bottom ?? bounds.top) + 8;
    if (reference && top + height > bounds.bottom) top = reference.top - height - 8;
    left = Math.max(bounds.left, Math.min(left, bounds.right - width));
    top = Math.max(bounds.top, Math.min(top, bounds.bottom - height));
    node.style.left = `${left / annotationZoom}px`;
    node.style.top = `${top / annotationZoom}px`;
  }

  function showThreadPopover(thread: AnnotationThread, trigger?: HTMLElement): void {
    threadPopover?.remove();
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
    applyZoom(popover);
    document.body.append(popover);
    threadPopover = popover;
    positionPopover(popover, thread.anchor, trigger);
  }

  function createCommentComposer(anchor?: AnnotationAnchor): HTMLElement {
    const section = createElement("section", "wm-annotation-composer wm-comment-popover");
    const heading = createElement("h2", "wm-annotation-composer-title");
    heading.textContent = "New comment";
    const textarea = createElement("textarea", "wm-annotation-textarea");
    textarea.rows = 3;
    textarea.placeholder = "Comment on the selected passage…";
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
    actions.append(cancel, submit);
    const form = createElement("form", "wm-annotation-form");
    form.append(heading, textarea, error, actions);
    section.append(form);
    cancel.addEventListener("click", () => {
      composer?.remove();
      composer = null;
      composerAnchor = undefined;
      section.remove();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = textarea.value.trim();
      const view = currentView();
      const resolvedAnchor = anchor ?? (view ? captureAnchor(view) : null);
      if (!resolvedAnchor) {
        error.textContent = "Select text in the document before commenting.";
        error.hidden = false;
        return;
      }
      if (!body) {
        error.textContent = "A comment cannot be empty.";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      setBusy(submit, true);
      Promise.resolve(onCreateComment({ body, anchor: resolvedAnchor })).then(() => {
        composer = null;
        composerAnchor = undefined;
        section.remove();
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
      const body = textarea.value.trim();
      if (!body) {
        error.textContent = "A reply cannot be empty.";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      setBusy(submit, true);
      Promise.resolve(onReply({ body, thread })).catch((reason: unknown) => {
        setBusy(submit, false);
        error.textContent = reason instanceof Error ? reason.message : "Reply could not be sent.";
        error.hidden = false;
      });
    });
    return form;
  }

  function editableAnnotation(thread: AnnotationThread, targetId: string, value: string, className: string): HTMLElement {
    const container = createElement("div", "wm-editable-annotation");
    const body = createElement("p", className);
    body.textContent = value;
    const edit = createElement("button", "wm-inline-edit");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit comment");
    edit.addEventListener("click", () => {
      const textarea = createElement("textarea", "wm-annotation-textarea");
      textarea.value = value;
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
      cancel.addEventListener("click", () => container.replaceChildren(body, edit));
      save.addEventListener("click", () => {
        const next = textarea.value.trim();
        if (!next) { textarea.focus(); return; }
        setBusy(save, true);
        Promise.resolve(onEdit({ thread, targetId, body: next })).catch((reason: unknown) => {
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
    container.append(body, edit);
    return container;
  }

  function renderThreadDetails(thread: AnnotationThread, orphaned: boolean): HTMLElement {
    const details = createElement("div", "wm-thread-details");
    const meta = createElement("time", "wm-thread-time");
    meta.dateTime = thread.createdAt;
    meta.textContent = formatTimestamp(thread.createdAt);
    details.append(meta);
    const quote = createElement("blockquote", "wm-thread-quote");
    quote.textContent = thread.anchor.exact || "(No quoted passage)";
    details.append(quote);
    details.append(editableAnnotation(thread, thread.id, thread.body, "wm-thread-body"));
    const replies = createElement("div", "wm-thread-replies");
    for (const reply of thread.replies ?? []) {
      const item = createElement("article", "wm-thread-reply");
      const replyMeta = createElement("div", "wm-thread-reply-meta");
      replyMeta.textContent = `${reply.actor} · ${formatTimestamp(reply.createdAt)}`;
      item.append(replyMeta, editableAnnotation(thread, reply.id, reply.body, "wm-thread-body"));
      replies.append(item);
    }
    details.append(replies);
    details.append(replyForm(thread));
    const threadActions = createElement("div", "wm-annotation-actions");
    const stateButton = createElement("button", "wm-button wm-button-secondary");
    stateButton.type = "button";
    stateButton.textContent = thread.resolved ? "Reopen" : "Resolve";
    stateButton.addEventListener("click", () => {
      const callback = thread.resolved ? onReopen : onResolve;
      Promise.resolve(callback(thread)).catch((reason: unknown) => {
        onNotice(reason instanceof Error ? reason.message : "Comment state could not be changed.");
      });
    });
    threadActions.append(stateButton);
    details.append(threadActions);
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

  function syncDecorations(): void {
    const view = currentView();
    if (view) view.dispatch(view.state.tr.setMeta(annotationUiPluginKey, { threads: visibleThreads() } satisfies AnnotationPluginMeta));
  }

  function renderThread(thread: AnnotationThread, orphaned: boolean): HTMLElement {
    const latest = latestMessage(thread);
    const card = createElement("article", "wm-thread-card");
    card.dataset.threadId = thread.id;
    card.dataset.actorColor = actorColor(latest.actor);
    if (thread.id === activeThreadId) card.classList.add("is-active");
    if (orphaned) card.classList.add("is-orphaned");
    const summary = createElement("button", "wm-thread-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", String(thread.id === activeThreadId));
    summary.setAttribute("aria-label", `Open thread started by ${thread.actor}`);
    const identity = createElement("span", "wm-thread-identity");
    const dot = createElement("span", "wm-actor-dot");
    dot.dataset.actorColor = actorColor(latest.actor);
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
    summary.append(identity, labels, excerpt);
    card.append(summary);

    const details = renderThreadDetails(thread, orphaned);
    details.hidden = thread.id !== activeThreadId;
    card.append(details);
    summary.addEventListener("click", () => {
      if (activeThreadId === thread.id) {
        threadPopover?.remove();
        threadPopover = null;
        activeThreadId = null;
        renderRail();
      } else controller.openThread(thread.id);
    });
    return card;
  }

  function renderRailVisibility(): void {
    rail.hidden = !railOpen;
  }

  function renderRail(): void {
    rail.replaceChildren();
    const content = createElement("div", "wm-annotation-rail-content");
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
    const header = createElement("header", "wm-annotation-rail-header");
    const title = createElement("h2");
    title.textContent = "Threads";
    const badge = createElement("span", "wm-pending-badge");
    const pending = attentionCount();
    badge.textContent = `${pending} need attention`;
    badge.hidden = pending === 0;
    badge.setAttribute("aria-label", `${pending} open threads need your attention`);
    const filter = createElement("label", "wm-unresolved-filter");
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = showResolved;
    checkbox.addEventListener("change", () => { showResolved = checkbox.checked; renderRail(); syncDecorations(); });
    filter.append(checkbox, document.createTextNode(" Show resolved"));
    const controls = createElement("div", "wm-annotation-rail-controls");
    const hide = createElement("button", "wm-hide-threads");
    hide.type = "button";
    hide.title = "Hide threads";
    hide.setAttribute("aria-label", "Hide threads");
    hide.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h10m-4-4 4 4-4 4m7-10v12"/></svg>';
    hide.addEventListener("click", () => controller.setRailOpen(false));
    controls.append(filter, hide);
    header.append(title, controls, badge);
    content.append(header);
    if (threads.length === 0) {
      const empty = createElement("p", "wm-empty-comments");
      empty.textContent = allThreads.length ? "No open threads." : "No threads.";
      content.append(empty);
    }
    for (const thread of validThreads) content.append(renderThread(thread, false));
    if (orphanedThreads.length > 0) {
      const group = createElement("section", "wm-orphan-group");
      const heading = createElement("h3");
      heading.textContent = "Orphaned threads";
      group.append(heading);
      for (const thread of orphanedThreads) group.append(renderThread(thread, true));
      content.append(group);
    }
    rail.append(content);
    renderRailVisibility();
  }

  function handleEditorClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const reference = event.target.closest<HTMLElement>([
      'sup[data-type="footnote_reference"]',
      "[data-footnote-reference]",
      "sup.footnote-reference",
    ].join(", "));
    if (!reference || !editorRoot) return;
    event.preventDefault();
    showFootnotePopover(editorRoot, reference);
  }

  editorRoot?.addEventListener("click", handleEditorClick);
  renderRail();
  onPendingCountChange(0);
  return controller;
}
