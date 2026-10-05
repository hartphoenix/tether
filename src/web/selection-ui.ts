import { iconSvg } from "./icons";
import { insertFootnote } from "./footnotes";
import { placeOverlay, type ViewportRect } from './overlay';
import { NodeSelection, Plugin, TextSelection, type EditorState, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { TooltipProvider } from "@milkdown/kit/plugin/tooltip";

import { createReviewNote } from "./editor-commands";

/**
 * The icon is exported for a host's `buildToolbar` item. The selection UI does
 * not install a second selection tooltip; it only provides the action target.
 */
export const reviewNoteIconSvg = iconSvg("pen-nib");

export interface InsertMenuItem { label: string; icon: string; run: () => void; }

export interface SelectionUiOptions {
  insertItems?: () => InsertMenuItem[];
  onNotice: (message: string) => void;
  onCodeComment?: (view: EditorView) => void;
}

export interface SelectionUiController {
  readonly plugin: MilkdownPlugin;
  openReviewNote(view: EditorView): void;
  openFootnote(view: EditorView): void;
  close(): void;
  destroy(): void;
}

interface AnchorPoint {
  x: number;
  y: number;
  above?: boolean;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const NOOP = () => undefined;

export function isCodeBlockTextSelection(selection: Selection): selection is TextSelection {
  return selection instanceof TextSelection
    && !selection.empty
    && selection.$from.parent === selection.$to.parent
    && selection.$from.parent.type.name === "code_block";
}

export function codeBlockSelectionBounds(codeBlock: HTMLElement): Bounds | null {
  const rectangles = [...codeBlock.querySelectorAll<HTMLElement>(".cm-selectionBackground")]
    .map((element) => element.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 || bounds.height > 0);
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map((bounds) => bounds.left));
  const top = Math.min(...rectangles.map((bounds) => bounds.top));
  const right = Math.max(...rectangles.map((bounds) => bounds.right));
  const bottom = Math.max(...rectangles.map((bounds) => bounds.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function clampPosition(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className = "wm-button"): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function labelFor(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element("label", "wm-field");
  const caption = element("span", "wm-field-label", text);
  label.append(caption, control);
  return label;
}

function selectedText(view: EditorView): string {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || selection.empty) return "";
  return doc.textBetween(selection.from, selection.to, "\n", "\n").trim();
}

class SelectionUi implements SelectionUiController {
  plugin!: MilkdownPlugin;

  private readonly notice: (message: string) => void;
  private readonly insertItems: () => InsertMenuItem[];
  private readonly codeComment: (view: EditorView) => void;
  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && (this.overlay || this.codeCommentToolbar)) {
      event.preventDefault();
      this.close();
    }
  };
  private readonly onDocumentPointerdown = (event: PointerEvent): void => {
    const target = event.target;
    if (this.overlay && target instanceof Node && !this.overlay.contains(target)) this.close();
  };
  private overlay: HTMLElement | null = null;
  private overlayCleanup: (() => void) | null = null;
  private staleSelection = false;
  private codeCommentToolbar: HTMLElement | null = null;
  private codeCommentProvider: TooltipProvider | null = null;
  private editorView: EditorView | null = null;
  private selectionSnapshot: Selection | null = null;
  private destroyed = false;

  constructor(options: SelectionUiOptions) {
    this.notice = options.onNotice ?? NOOP;
    this.insertItems = options.insertItems ?? (() => []);
    this.codeComment = options.onCodeComment ?? NOOP;
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", this.onDocumentKeydown, true);
      document.addEventListener("pointerdown", this.onDocumentPointerdown, true);
    }
  }

  attachView(view: EditorView): void {
    this.editorView = view;
    this.updateCodeCommentToolbar(view);
  }

  detachView(view: EditorView): void {
    if (this.editorView === view) this.editorView = null;
    this.close();
  }

  close(): void {
    this.overlayCleanup?.();
    this.overlayCleanup = null;
    this.overlay?.remove();
    this.overlay = null;
    this.hideCodeCommentToolbar();
    this.selectionSnapshot = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close();
    this.editorView = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", this.onDocumentKeydown, true);
      document.removeEventListener("pointerdown", this.onDocumentPointerdown, true);
    }
  }

  openFootnote(view: EditorView): void {
    if (this.destroyed || !view.editable) return;
    this.close();
    this.editorView = view;
    this.selectionSnapshot = view.state.selection;
    const chosen = this.selectionSnapshot;
    const popover = element("section", "wm-popover wm-comment-popover wm-footnote-composer");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Insert footnote");
    const heading = element("h2", "wm-annotation-composer-title", "New footnote");
    const note = element("textarea", "wm-annotation-textarea");
    note.rows = 3;
    note.placeholder = "footnote text...";
    note.setAttribute("aria-label", "Footnote text");
    const error = element("p", "wm-annotation-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const cancel = button("Cancel", "wm-button wm-button-secondary");
    const submit = button("Insert footnote", "wm-button wm-button-primary");
    submit.type = "submit";
    const actions = element("div", "wm-annotation-actions");
    actions.append(cancel, submit);
    const form = element("form", "wm-annotation-form");
    form.append(heading, note, error, actions);
    popover.append(form);
    cancel.addEventListener("click", () => { this.close(); view.focus(); });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const result = this.staleSelection ? { ok: false, reason: "The document changed. Reopen this action." } : insertFootnote(view, note.value, chosen);
      if (!result.ok) { error.textContent = result.reason!; error.hidden = false; return; }
      this.close();
    });
    note.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); }
    });
    this.mount(popover, this.selectionAnchor(view));
    note.focus();
  }

  openReviewNote(view: EditorView): void {
    if (this.destroyed) return;
    const text = selectedText(view);
    this.close();
    if (!text) {
      this.notice("Select some text before adding a review note.");
      return;
    }
    this.editorView = view;
    this.selectionSnapshot = view.state.selection;
    const noteSelection = this.selectionSnapshot;
    const popover = element("section", "wm-popover wm-dialog");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Add review note");
    const heading = element("h2", "wm-dialog-title", "Add review note");
    const context = element("p", "wm-context", `Selected text: “${text.slice(0, 180)}${text.length > 180 ? "…" : ""}”`);
    const textarea = element("textarea", "wm-textarea");
    textarea.rows = 5;
    textarea.placeholder = "Write a review note…";
    textarea.setAttribute("aria-label", "Review note");
    const error = element("p", "wm-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const cancel = button("Cancel", "wm-button wm-button-secondary");
    const save = button("Add note", "wm-button wm-button-primary");
    const actions = element("div", "wm-actions");
    actions.append(cancel, save);
    popover.append(heading, context, labelFor("Review note", textarea), error, actions);
    cancel.addEventListener("click", () => this.close());
    const submit = (): void => {
      const note = textarea.value.trim();
      if (!note) {
        error.textContent = "Enter a review note, or cancel.";
        error.hidden = false;
        textarea.focus();
        return;
      }
      this.accept(view, () => createReviewNote(view, note, noteSelection ?? undefined));
    };
    save.addEventListener("click", submit);
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    this.mount(popover, this.selectionAnchor(view));
    textarea.focus();
  }

  private updateCodeCommentToolbar(view: EditorView): void {
    const selection = view.state.selection;
    const root = view.dom.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement;
    const codeBlock = active instanceof Element ? active.closest<HTMLElement>(".milkdown-code-block") : null;
    if (!view.editable || !codeBlock || !isCodeBlockTextSelection(selection)) {
      this.hideCodeCommentToolbar();
      return;
    }

    this.hideCodeCommentToolbar();
    const toolbar = element("div", "milkdown-toolbar wm-code-comment-toolbar");
    toolbar.dataset.show = "true";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Selection actions");
    const comment = button("", "toolbar-item");
    comment.dataset.toolbarItem = "comment";
    comment.title = "Comment";
    comment.setAttribute("aria-label", "Comment");
    comment.innerHTML = reviewNoteIconSvg;
    comment.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.hideCodeCommentToolbar();
      this.codeComment(view);
    });
    toolbar.append(comment);
    (view.dom.closest(".milkdown") ?? view.dom.parentElement ?? view.dom).append(toolbar);
    this.codeCommentToolbar = toolbar;
    const provider = new TooltipProvider({ content: toolbar, offset: 10 });
    this.codeCommentProvider = provider;
    provider.show({ getBoundingClientRect: () => this.codeCommentBounds(codeBlock) }, view);
  }

  private codeCommentBounds(codeBlock: HTMLElement): DOMRect {
    const renderedSelectionBounds = codeBlockSelectionBounds(codeBlock);
    let bounds: Bounds = renderedSelectionBounds ?? codeBlock.getBoundingClientRect();
    const nativeSelection = codeBlock.ownerDocument.getSelection();
    if (!renderedSelectionBounds && nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount > 0) {
      const range = nativeSelection.getRangeAt(0);
      const rangeBounds = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      if (rangeBounds && (rangeBounds.width || rangeBounds.height)) bounds = rangeBounds;
    }
    return new DOMRect(bounds.left, bounds.top, bounds.width, bounds.height);
  }

  private hideCodeCommentToolbar(): void {
    this.codeCommentProvider?.destroy();
    this.codeCommentProvider = null;
    this.codeCommentToolbar?.remove();
    this.codeCommentToolbar = null;
  }

  handleContextMenu(view: EditorView, event: MouseEvent): boolean {
    if (this.destroyed || !view.editable) return false;
    event.preventDefault();
    this.editorView = view;
    this.close();
    const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (coords && !this.selectionIncludes(view.state.selection, coords.pos)) {
      const selection = this.selectionAt(view, coords.pos);
      if (selection && !selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
    }
    this.openMenu(view, event.clientX, event.clientY);
    return true;
  }

  private selectionIncludes(selection: Selection, pos: number): boolean {
    return selection.from <= pos && pos <= selection.to;
  }

  private selectionAt(view: EditorView, position: number): Selection | null {
    const { doc } = view.state;
    const pos = clampPosition(position, 0, doc.content.size);
    const resolved = doc.resolve(pos);
    const node = resolved.nodeAfter;
    if (node && !node.isText && (node.isAtom || node.type.spec.selectable !== false)) {
      try {
        return NodeSelection.create(doc, pos);
      } catch {
        // A node can be selectable in the schema but not at this exact
        // coordinate. Fall through to a nearby text selection.
      }
    }
    try {
      return TextSelection.near(resolved, 1);
    } catch {
      return null;
    }
  }

  private openMenu(view: EditorView, x: number, y: number): void {
    this.selectionSnapshot = view.state.selection;
    const menu = element("div", "wm-context-menu wm-insert-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Insert");
    for (const action of this.insertItems()) {
      const item = button("", "wm-menu-item");
      item.setAttribute("role", "menuitem");
      const icon = element("span", "wm-insert-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = action.icon;
      item.append(icon, element("span", undefined, action.label));
      item.addEventListener("click", () => this.accept(view, () => { view.focus(); action.run(); }));
      menu.append(item);
    }
    menu.addEventListener("keydown", event => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
    });
    this.mount(menu, { x, y });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  private accept(view: EditorView, operation: () => unknown): void {
    if (this.staleSelection) { this.notice('The document changed. Reopen this action before applying it.'); return; }
    const snapshot = this.selectionSnapshot;
    this.close();
    if (snapshot && !view.state.selection.eq(snapshot)) {
      try {
        view.dispatch(view.state.tr.setSelection(snapshot));
      } catch {
        // A command layer can still report a useful notice if a document was
        // replaced between opening the dialog and accepting it.
      }
    }
    try {
      const result = operation();
      const commandResult = result && typeof result === "object" ? result as { ok?: unknown; reason?: unknown } : null;
      if (commandResult?.ok === false) {
        this.notice(typeof commandResult.reason === "string" ? commandResult.reason : "The editor action failed.");
        return;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).catch((error) => this.notice(error instanceof Error ? error.message : "The editor action failed."));
      }
    } catch (error) {
      this.notice(error instanceof Error ? error.message : "The editor action failed.");
    }
  }

  private selectionAnchor(view: EditorView): AnchorPoint {
    try {
      const start = view.coordsAtPos(view.state.selection.from);
      const end = view.coordsAtPos(view.state.selection.to);
      return { x: Math.min(start.left, end.left), y: Math.max(start.bottom, end.bottom) };
    } catch {
      return { x: 16, y: 16 };
    }
  }

  invalidateAnchor(): void { this.staleSelection = true; }

  private mount(node: HTMLElement, anchor: AnchorPoint): void {
    if (this.destroyed || typeof document === "undefined" || !document.body) return;
    this.overlayCleanup?.();
    this.overlay?.remove();
    this.overlay = node;
    this.staleSelection = false;
    const view = this.editorView;
    const selection = view?.state.selection;
    const pointer = node.classList.contains('wm-context-menu');
    document.body.append(node);
    this.overlayCleanup = placeOverlay(node, {
      root: view?.dom.closest<HTMLElement>('#editor') ?? undefined,
      policy: pointer ? 'dismiss' : 'pin',
      close: () => this.close(),
      above: anchor.above,
      reference: (): ViewportRect | null => {
        if (pointer) return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
        if (this.staleSelection || !view || !selection) return null;
        const start = view.coordsAtPos(selection.from), end = view.coordsAtPos(selection.to);
        return { left: Math.min(start.left, end.left), right: Math.max(start.right, end.right), top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
      },
    });
  }

}

export function createSelectionUi(options: SelectionUiOptions): SelectionUiController {
  const controller = new SelectionUi(options);
  controller.plugin = $prose((_ctx) => new Plugin({
    props: {
      handleDOMEvents: {
        contextmenu(view, event) {
          return controller.handleContextMenu(view, event as MouseEvent);
        },
      },
    },
    view(view) {
      controller.attachView(view);
      return {
        update(nextView, previousState?: EditorState) {
          if (previousState && !nextView.state.doc.eq(previousState.doc)) controller.invalidateAnchor();
          controller.attachView(nextView);
        },
        destroy() {
          controller.destroy();
        },
      };
    },
  }));
  return controller;
}
