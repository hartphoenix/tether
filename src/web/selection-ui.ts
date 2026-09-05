import { NodeSelection, Plugin, TextSelection, type EditorState, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { TooltipProvider } from "@milkdown/kit/plugin/tooltip";

import {
  createReviewNote,
  getSelectionTags,
  removeTag,
  setTagEnabled,
  updateTag,
  type TagDescriptor,
} from "./editor-commands";

/**
 * The icon is exported for a host's `buildToolbar` item. The selection UI does
 * not install a second selection tooltip; it only provides the action target.
 */
export const reviewNoteIconSvg =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16.5H12l-4.25 3v-3H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 8h10M7 11h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

export interface SelectionUiOptions {
  onNotice: (message: string) => void;
  onCodeComment?: (view: EditorView) => void;
}

export interface SelectionUiController {
  readonly plugin: MilkdownPlugin;
  openReviewNote(view: EditorView): void;
  close(): void;
  destroy(): void;
}

interface NormalizedDescriptor {
  kind: "link" | "block" | "review" | "mark" | "unknown";
  label: string;
  state: TagDescriptor["state"];
  value: unknown;
  summary: string;
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

interface StyleDraft {
  read(): string | null;
  commit(css: string): void;
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

function normalizeDescriptor(descriptor: TagDescriptor): NormalizedDescriptor {
  const kind = descriptor.id === "mark:link"
    ? "link"
    : descriptor.kind === "block" || descriptor.kind === "review" || descriptor.kind === "mark"
      ? descriptor.kind
      : "unknown";
  const summary = descriptor.kind === "mark"
    ? descriptor.state === "mixed" ? "Mixed across selection" : descriptor.state === "off" ? "Available" : "Applied"
    : typeof descriptor.value === "string" ? descriptor.value : "";
  return { kind, label: descriptor.label, state: descriptor.state, value: descriptor.value, summary };
}

const STYLE_PROPERTIES = new Set([
  "background-color",
  "border",
  "border-radius",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "margin-block",
  "padding",
  "text-decoration",
]);

function styleSelector(descriptor: TagDescriptor): string | null {
  const type = descriptor.identity.type;
  if (type === "strong") return "strong";
  if (type === "emphasis" || type === "em") return "em";
  if (["strike_through", "strike", "strikethrough"].includes(type)) return "s";
  if (["inlineCode", "inline_code", "code"].includes(type)) return "code";
  if (type === "link") return "a";
  if (type === "heading") return `h${typeof descriptor.value === "number" ? descriptor.value : 1}`;
  if (type === "paragraph") return "p";
  if (type === "footnote_reference") return 'sup[data-type="footnote_reference"]';
  if (type === "blockquote") return "blockquote";
  if (["bullet_list", "task_list"].includes(type)) return "ul";
  if (type === "ordered_list") return "ol";
  if (["list_item", "task_list_item"].includes(type)) return "li";
  if (type.startsWith("table")) return "table";
  return null;
}

function defaultStyle(descriptor: TagDescriptor): string {
  if (descriptor.id === "mark:strong") return "font-weight: 700;";
  if (descriptor.id === "mark:emphasis") return "font-style: italic;";
  if (descriptor.id === "mark:strike") return "text-decoration: line-through;";
  if (descriptor.id === "mark:inline-code") return "font-family: ui-monospace, monospace; background-color: #2b3037;";
  if (descriptor.id === "mark:link") return "color: #82b7ff; text-decoration: underline;";
  if (descriptor.kind === "block" && descriptor.identity.type === "heading") {
    return "font-weight: 700; line-height: 1.25;";
  }
  if (descriptor.kind === "block") return "line-height: 1.6;";
  if (descriptor.kind === "review") return "color: #e4bd58; font-weight: 700;";
  return "";
}

export function normalizeStyle(source: string): { css: string; error?: string } {
  const declarations: string[] = [];
  for (const part of source.split(";")) {
    const declaration = part.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(":");
    if (separator < 1) return { css: "", error: `Invalid declaration: ${declaration}` };
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!STYLE_PROPERTIES.has(property)) return { css: "", error: `${property} is not an editable style property.` };
    if (!value || /url\s*\(|expression\s*\(|[{}]/i.test(value)) return { css: "", error: `Invalid value for ${property}.` };
    if (globalThis.CSS?.supports && !globalThis.CSS.supports(property, value)) {
      return { css: "", error: `Invalid value for ${property}.` };
    }
    declarations.push(`${property}: ${value}`);
  }
  return { css: declarations.length ? `${declarations.join("; ")};` : "" };
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
  private readonly codeComment: (view: EditorView) => void;
  private readonly scopeClass = `wm-editor-scope-${crypto.randomUUID().replaceAll("-", "")}`;
  private readonly styleOverrides = new Map<string, string>();
  private readonly styleElement: HTMLStyleElement | null;
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
  private codeCommentToolbar: HTMLElement | null = null;
  private codeCommentProvider: TooltipProvider | null = null;
  private editorView: EditorView | null = null;
  private selectionSnapshot: Selection | null = null;
  private destroyed = false;

  constructor(options: SelectionUiOptions) {
    this.notice = options.onNotice ?? NOOP;
    this.codeComment = options.onCodeComment ?? NOOP;
    this.styleElement = typeof document === "undefined" ? null : document.createElement("style");
    if (this.styleElement) {
      this.styleElement.dataset.waveMarkdownStyles = this.scopeClass;
      document.head.append(this.styleElement);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", this.onDocumentKeydown, true);
      document.addEventListener("pointerdown", this.onDocumentPointerdown, true);
    }
  }

  attachView(view: EditorView): void {
    this.editorView = view;
    view.dom.classList.add(this.scopeClass);
    this.updateCodeCommentToolbar(view);
  }

  detachView(view: EditorView): void {
    if (this.editorView === view) this.editorView = null;
    this.close();
  }

  close(): void {
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
    this.styleElement?.remove();
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", this.onDocumentKeydown, true);
      document.removeEventListener("pointerdown", this.onDocumentPointerdown, true);
    }
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
    (view.dom.parentElement ?? view.dom).append(toolbar);
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
    if (this.destroyed) return false;
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
    const menu = element("div", "wm-context-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Editor actions");
    const tags = button("Tags…", "wm-menu-item");
    tags.setAttribute("role", "menuitem");
    tags.addEventListener("click", () => this.openTags(view));
    menu.append(tags);
    this.mount(menu, { x, y });
    tags.focus();
  }

  private openTags(view: EditorView): void {
    let descriptors: TagDescriptor[];
    try {
      descriptors = getSelectionTags(view) ?? [];
    } catch (error) {
      this.notice(error instanceof Error ? error.message : "Could not read tags for this selection.");
      this.close();
      return;
    }
    this.close();
    this.editorView = view;
    this.selectionSnapshot = view.state.selection;
    const popover = element("section", "wm-popover wm-tags");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Tags");
    const heading = element("h2", "wm-dialog-title", "Tags");
    const search = element("input", "wm-input wm-tag-search");
    search.type = "search";
    search.placeholder = "Search tags…";
    search.setAttribute("aria-label", "Search tags");
    popover.append(heading, search);
    if (!descriptors.length) {
      popover.append(element("p", "wm-context", "No tags apply to the current selection."));
    } else {
      const list = element("div", "wm-tag-list");
      list.setAttribute("role", "list");
      const rows = descriptors.map((descriptor) => this.tagRow(view, descriptor));
      rows.forEach((row) => list.append(row));
      const empty = element("p", "wm-context", "No tags match this search.");
      empty.hidden = true;
      search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        rows.forEach((row) => {
          const matches = !query || (row.dataset.search ?? "").includes(query);
          row.hidden = !matches;
          if (matches) visible += 1;
        });
        empty.hidden = visible > 0;
      });
      popover.append(list, empty);
    }
    this.mount(popover, this.selectionAnchor(view));
    search.focus();
  }

  private tagRow(view: EditorView, descriptor: TagDescriptor): HTMLElement {
    const normalized = normalizeDescriptor(descriptor);
    const row = element("div", "wm-tag-row");
    row.setAttribute("role", "listitem");
    row.dataset.search = `${descriptor.label} ${descriptor.id} ${descriptor.identity.type}`.toLowerCase();
    const toggle = element("input", "wm-tag-toggle");
    toggle.type = "checkbox";
    toggle.checked = normalized.state !== "off";
    toggle.indeterminate = normalized.state === "mixed";
    const canApply = descriptor.kind === "mark" && descriptor.state === "off";
    toggle.disabled = !descriptor.removable && !canApply;
    toggle.setAttribute("aria-label", canApply ? `Apply ${normalized.label}` : descriptor.removable ? `Remove ${normalized.label}` : `${normalized.label} is required or read-only`);
    toggle.setAttribute("aria-checked", normalized.state);
    toggle.dataset.state = normalized.state;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (descriptor.id === "mark:link" && descriptor.state === "off") {
        this.openTagDetail(view, descriptor, normalized);
        return;
      }
      this.accept(view, () => setTagEnabled(view, descriptor, descriptor.state === "off"));
    });
    const name = button(normalized.label, "wm-tag-name");
    name.setAttribute("aria-label", `Edit ${normalized.label}`);
    name.addEventListener("click", () => this.openTagDetail(view, descriptor, normalized));
    row.append(toggle, name);
    if (normalized.summary) row.append(element("span", "wm-tag-summary", normalized.summary));
    return row;
  }

  private openTagDetail(view: EditorView, descriptor: TagDescriptor, normalized: NormalizedDescriptor): void {
    this.close();
    this.editorView = view;
    this.selectionSnapshot = view.state.selection;
    const popover = element("section", "wm-popover wm-dialog wm-tag-detail");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `${normalized.label} details`);
    popover.append(element("h2", "wm-dialog-title", normalized.label));
    const content = element("div", "wm-detail-content");
    const actions = element("div", "wm-actions");
    const cancel = button("Cancel", "wm-button wm-button-secondary");
    actions.append(cancel);
    cancel.addEventListener("click", () => this.close());
    const error = element("p", "wm-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    if (normalized.kind === "link") {
      this.linkDetail(view, descriptor, content, actions, error);
    } else if (normalized.kind === "block") {
      this.blockDetail(view, descriptor, content, actions, error);
    } else if (normalized.kind === "review") {
      this.reviewDetail(view, descriptor, normalized, content, actions, error);
    } else if (normalized.kind === "mark") {
      this.markDetail(view, descriptor, normalized, content, actions, error);
    } else if (styleSelector(descriptor)) {
      this.styleOnlyDetail(view, descriptor, content, actions, error);
    } else {
      const reason = descriptor.reason || "This tag is read-only in the current selection.";
      content.append(element("p", "wm-context", reason));
      if (normalized.summary) content.append(element("p", "wm-reference", normalized.summary));
      if (descriptor.removable) this.addRemove(view, descriptor, actions);
    }
    popover.append(content, error, actions);
    this.mount(popover, this.selectionAnchor(view));
    (popover.querySelector("input, select, textarea, button") as HTMLElement | null)?.focus();
  }

  private createStyleDraft(view: EditorView, descriptor: TagDescriptor, content: HTMLElement, error: HTMLElement): StyleDraft | null {
    const selector = styleSelector(descriptor);
    if (!selector) return null;
    const source = element("textarea", "wm-textarea wm-style-source");
    source.rows = 4;
    source.value = this.styleOverrides.get(selector) ?? defaultStyle(descriptor);
    source.placeholder = "font-size: 1.2em; color: #e7e9ec;";
    source.setAttribute("aria-label", `${descriptor.label} CSS declarations`);
    const preview = element("div", "wm-style-preview", selectedText(view) || descriptor.label);
    preview.setAttribute("aria-label", "Style preview");
    const hint = element("p", "wm-context", "Editable: font, color, background, spacing, border, and text decoration properties.");
    const refresh = (): string | null => {
      const result = normalizeStyle(source.value);
      if (result.error) {
        error.textContent = result.error;
        error.hidden = false;
        preview.removeAttribute("style");
        return null;
      }
      error.hidden = true;
      preview.style.cssText = result.css;
      return result.css;
    };
    source.addEventListener("input", refresh);
    refresh();
    content.append(labelFor("Style declarations", source), hint, preview);
    return {
      read: refresh,
      commit: (css) => {
        if (css) this.styleOverrides.set(selector, css);
        else this.styleOverrides.delete(selector);
        this.renderStyleOverrides();
      },
    };
  }

  private renderStyleOverrides(): void {
    if (!this.styleElement) return;
    this.styleElement.textContent = [...this.styleOverrides.entries()]
      .map(([selector, css]) => `.${this.scopeClass} ${selector} { ${css} }`)
      .join("\n");
  }

  private saveStyleOnly(view: EditorView, draft: StyleDraft | null, actions: HTMLElement): void {
    const save = button("Apply style", "wm-button wm-button-primary");
    actions.append(save);
    save.addEventListener("click", () => {
      const css = draft?.read();
      if (css == null) return;
      this.accept(view, () => {
        draft?.commit(css);
        return { ok: true };
      });
    });
  }

  private styleOnlyDetail(view: EditorView, descriptor: TagDescriptor, content: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
    this.saveStyleOnly(view, this.createStyleDraft(view, descriptor, content, error), actions);
  }

  private linkDetail(view: EditorView, descriptor: TagDescriptor, content: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
    const draft = this.createStyleDraft(view, descriptor, content, error);
    const current = descriptor.value && typeof descriptor.value === "object" ? descriptor.value : {};
    const url = element("input", "wm-input");
    url.type = "url";
    url.value = typeof current.href === "string" ? current.href : typeof current.url === "string" ? current.url : "";
    url.placeholder = "https://example.com";
    const title = element("input", "wm-input");
    title.type = "text";
    title.value = typeof current.title === "string" ? current.title : "";
    title.placeholder = "Optional title";
    content.append(labelFor("URL", url), labelFor("Title", title));
    const save = button("Save", "wm-button wm-button-primary");
    actions.append(save);
    save.addEventListener("click", () => {
      const href = url.value.trim();
      const css = draft?.read();
      if (css == null) return;
      if (!href) {
        error.textContent = "Enter a URL, or cancel.";
        error.hidden = false;
        url.focus();
        return;
      }
      this.accept(view, () => {
        const result = updateTag(view, descriptor, { href, title: title.value.trim() });
        if (result.ok) draft?.commit(css);
        return result;
      });
    });
    this.enterToSubmit([url, title], save);
  }

  private blockDetail(view: EditorView, descriptor: TagDescriptor, content: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
    this.saveStyleOnly(view, this.createStyleDraft(view, descriptor, content, error), actions);
  }

  private reviewDetail(view: EditorView, descriptor: TagDescriptor, normalized: NormalizedDescriptor, content: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
    const draft = this.createStyleDraft(view, descriptor, content, error);
    const textarea = element("textarea", "wm-textarea");
    textarea.rows = 5;
    textarea.value = typeof descriptor.value === "string" ? descriptor.value : "";
    textarea.setAttribute("aria-label", "Review note");
    content.append(labelFor("Review note", textarea));
    const save = button("Save", "wm-button wm-button-primary");
    actions.append(save);
    save.addEventListener("click", () => {
      const note = textarea.value.trim();
      const css = draft?.read();
      if (css == null) return;
      if (!note) {
        error.textContent = "Enter a review note, or cancel.";
        error.hidden = false;
        textarea.focus();
        return;
      }
      this.accept(view, () => {
        const result = updateTag(view, descriptor, note);
        if (result.ok) draft?.commit(css);
        return result;
      });
    });
    this.enterToSubmit([textarea], save, true);
    if (normalized.summary && !textarea.value) content.append(element("p", "wm-context", normalized.summary));
  }

  private addRemove(view: EditorView, descriptor: TagDescriptor, actions: HTMLElement): void {
    const remove = button("Remove", "wm-button wm-button-danger");
    actions.append(remove);
    remove.addEventListener("click", () => this.accept(view, () => removeTag(view, descriptor)));
  }

  private markDetail(view: EditorView, descriptor: TagDescriptor, normalized: NormalizedDescriptor, content: HTMLElement, actions: HTMLElement, error: HTMLElement): void {
    content.append(
      element("p", "wm-context", normalized.state === "mixed" ? "This binary mark is mixed across the selection." : normalized.state === "on" ? "This binary mark is applied to the selection." : "This binary mark is not applied to the selection."),
    );
    if (normalized.summary) content.append(element("p", "wm-reference", normalized.summary));
    this.saveStyleOnly(view, this.createStyleDraft(view, descriptor, content, error), actions);
    if (descriptor.removable) this.addRemove(view, descriptor, actions);
  }

  private enterToSubmit(controls: HTMLElement[], submit: HTMLButtonElement, textarea = false): void {
    controls.forEach((control) => control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!textarea || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit.click();
      }
    }));
  }

  private accept(view: EditorView, operation: () => unknown): void {
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

  private mount(node: HTMLElement, anchor: AnchorPoint): void {
    if (this.destroyed || typeof document === "undefined" || !document.body) return;
    this.overlay?.remove();
    this.overlay = node;
    document.body.append(node);
    this.position(node, anchor);
  }

  private position(node: HTMLElement, anchor: AnchorPoint): void {
    const margin = 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 240;
    const width = node.offsetWidth || Math.min(320, viewportWidth - margin * 2);
    const height = node.offsetHeight || 44;
    const left = clampPosition(anchor.x, margin, viewportWidth - width - margin);
    let top = anchor.above ? anchor.y - height - margin : anchor.y + margin;
    if (top + height > viewportHeight - margin) top = anchor.y - height - margin;
    top = clampPosition(top, margin, viewportHeight - height - margin);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
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
          if (previousState && !nextView.state.doc.eq(previousState.doc)) controller.close();
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
