import { mountMobileFolio } from "./mobile-folio";
import { createSourceEditor } from './source-editor';
import { diagramViewer } from "./diagram-viewer";
import { configureMarkdownSerialization } from "./markdown-serialization";
import { createThreadSizing } from './thread-sizing';
import { createFileActions } from './file-actions';
import { scrollToDocumentAnchor } from './anchor-navigation';
import { linkFragment } from '../shared/link-fragment';
import { headingAnchors } from './heading-anchors';
import { configureFootnotes, footnoteIcon, footnoteOrdering } from "./footnotes";
import { createChangesInspector, updateReaderBody } from "./reader-changes";
import { imageDisplayUrl } from "./image-url";
import { renderMermaidPreview, setMermaidPreviews } from "./mermaid-preview";
import { installReaderFind } from "./reader-find";
import { installMenuMotion } from "./motion";
import { createRailResize } from "./rail-resize";
import { updateControlStyles } from "./update-controls";
import { mountUpdateNotice } from "./update-notice";
import { iconSvg } from "./icons";
import { decreaseQuoteLevel } from "./editor-commands";
import { Crepe } from "@milkdown/crepe";
import { EditorStatus, editorStateOptionsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose, replaceAll, callCommand } from "@milkdown/kit/utils";
import { createCodeBlockCommand } from "@milkdown/kit/preset/commonmark";
import { createAnnotationUi, captureAnchor, type AnnotationThread, type AnnotationUiController } from "./annotations-ui";
import { apiErrorMessage } from "./api-error";
import { createChromeControls } from "./chrome-controls";
import { createCanvas } from './canvas';
import { scrollSelectionIntoView } from './scroll-geometry';
import './canvas.css';
import { createIncomingNavigator, acceptIncomingDiff, cancelIncomingDiff, incomingDiffActive, incomingDiffPlugins, startIncomingDiff, matchesIncomingDocument } from "./incoming-diff";
import { documentLinkPath, localDocumentLink, opensAsDocument } from "./local-document-link";
import { prepareMarkdown, restoreMarkdown } from "../core/markdown-codec";
import { createSelectionUi, reviewNoteIconSvg, type SelectionUiController } from "./selection-ui";
import { createThemePicker } from "./themes";
import { documentTabTitle, filenameStem } from "./document-title";
import { DraftPersistence, recoverDraft } from "./draft-recovery";
import { createReconnectLoop } from "./reconnect";
import { installCmuxFindCompatibility } from "./hosts/cmux-find";
import { initialReaderSelection } from "./initial-selection";
import type { SessionBootstrap } from "../shared/contracts";
import "./annotations-ui.css";
import "./chrome.css";
import "./selection-ui.css";
import "./themes.css";
import "./style.css";
import "./fonts.css";
import "./theme-maker.css";
import "./thread-layout.css";
import "./phone-reader.css";

type ServerComment = { id: string; seq: number; actor: string; createdAt: string; body: string; anchor: AnnotationThread["anchor"] };
type ServerReply = { id: string; seq: number; actor: string; createdAt: string; body: string };
type ServerThread = { id: string; comment: ServerComment; replies: ServerReply[]; status: "open" | "resolved"; orphan?: { status?: string }; deleted?: boolean };
type AnnotationState = {
  header?: { baseBodyRevision?: string };
  threads?: ServerThread[];
  acknowledgements?: Array<{ actor: string; bodyRevision: string }>;
  maxSequence?: number;
};
type DocumentResponse = {
  path: string; body: string; content: string; bodyRevision: string; ledgerRevision: string; revision: string; annotations: AnnotationState;
  readOnly?: boolean; ledgerError?: string; bodyEditable?: boolean;
  diagramPalette?: import("../shared/diagram-theme").DiagramPalette;
  diagramPreviews?: Record<string, string | null>;
};
type AnnotationResponse = {
  path: string; bodyRevision: string; ledgerRevision: string; annotations: AnnotationState; pending?: unknown[]; events?: unknown[];
};
type IncomingReview = { bodyRevision: string; ledgerRevision: string; frontmatter: string; body: string; editorDoc?: ProseMirrorNode };

for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  slot.outerHTML = iconSvg(slot.dataset.icon as Parameters<typeof iconSvg>[0]);
}

const clientId = crypto.randomUUID();
installCmuxFindCompatibility(window);
installMenuMotion(document);
const localActor = "human";
const targetActor = "assistant";

const notice = document.querySelector<HTMLElement>("#notice")!;
const toolbarControls = document.querySelector<HTMLElement>("#toolbar-controls")!;
const sourceButton = document.querySelector<HTMLButtonElement>('#source')!;
const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;
const themeMenu = document.querySelector<HTMLElement>("#theme-menu")!;
const zoomButton = document.querySelector<HTMLButtonElement>("#zoom")!;
const zoomMenu = document.querySelector<HTMLElement>("#zoom-menu")!;
const zoomSlider = document.querySelector<HTMLInputElement>("#zoom-slider")!;
const zoomLabel = document.querySelector<HTMLElement>("#zoom-label")!;
const commentButton = document.querySelector<HTMLButtonElement>("#comment")!;
const pendingCount = document.querySelector<HTMLElement>("#pending-count")!;
const editorRoot = document.querySelector<HTMLElement>("#editor")!;
const annotationsRoot = document.querySelector<HTMLElement>("#annotations")!;
const conflictBar = document.querySelector<HTMLElement>("#conflict")!;
const conflictMessage = document.querySelector<HTMLElement>("#conflict-message")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload")!;
const saveReviewButton = document.querySelector<HTMLButtonElement>("#save-review")!;
const reviewNavigation = createIncomingNavigator(getEditorView);
const nextChangeButton = document.querySelector<HTMLButtonElement>("#next-change")!;
const previousChangeButton = document.querySelector<HTMLButtonElement>("#previous-change")!;
nextChangeButton.addEventListener("click", () => reviewNavigation.move(1));
previousChangeButton.addEventListener("click", () => reviewNavigation.move(-1));
const cancelReviewButton = document.querySelector<HTMLButtonElement>("#cancel-review")!;

let crepe: Crepe | null = null;
let canvas: ReturnType<typeof createCanvas> | null = null;
document.addEventListener("wm-before-rail-layout", () => canvas?.setScale(canvas.scale));
let selectionUi: SelectionUiController | null = null;
let annotationUi: AnnotationUiController | null = null;
let toolbarLabelObserver: MutationObserver | null = null;
let overflowCleanup: (() => void) | null = null;
let currentPath = "";
let currentBodyRevision = "";
let currentLedgerRevision = "";
let currentFrontmatter = "";
let savedEditorMarkdown = "";
let diskBody = "";
let sourceEditor: ReturnType<typeof createSourceEditor> | null = null;
let annotationState: AnnotationState = {};
let saveTimer: number | undefined;
let saveInFlight = false;
let saveAgain = false;
let conflicted = false;
let switching = false;
let disconnected = false;
let incomingReview: IncomingReview | null = null;
let documentGeneration = 0;
let readOnly = false;
let ledgerReadOnly = false;
let initialized = false;
let initializing = false;
let revealAvailable = false;

const chrome = createChromeControls({
  notice, zoomButton, zoomMenu, zoomSlider, zoomLabel,
  onZoomChange: (scale) => {
    const zoom = scale / 100;
    canvas?.setScale(zoom);
    persistPosition();
  },
});
let themePicker: ReturnType<typeof createThemePicker> | null = null;
const changesInspector = createChangesInspector();
let appearanceRevision = "";
let updateMounted = false;
let stopFind: (() => void) | undefined;
let railResize: ReturnType<typeof createRailResize> | null = null;
const threadSizing = createThreadSizing(async value => {
  applyAppearance(await api('api/preferences', { method: 'PUT', body: JSON.stringify(value) }));
}, message => chrome.setNotice(message));
const fileActions = createFileActions({
  path: () => currentPath,
  notice: message => chrome.setNotice(message),
  copy: async () => { await navigator.clipboard.writeText(currentPath); chrome.setNotice('File path copied.'); },
  reveal: async () => { await api('api/file/reveal', { method: 'POST' }); },
  move: async target => {
    if (!(await save())) throw new Error('Save or resolve the current conflict before moving.');
    const result = await api<{ path: string; cancelled?: boolean }>('api/file/move', { method: 'POST', body: JSON.stringify(target === undefined ? { pickDirectory: true } : { target }) });
    if (result.cancelled) return;
    currentPath = result.path;
    document.title = filenameStem(currentPath);
    chrome.setNotice('File moved.');
  },
  export: exportReview,
});
toolbarControls.prepend(fileActions.root);
let appearance: { uiScale?: number; railWidth?: number; commentTextSize?: number } = {};
function applyAppearance(value: typeof appearance) {
  appearance = value;
  document.documentElement.style.setProperty('--wm-ui-scale', String(value.uiScale ?? 1));
  document.documentElement.style.setProperty('--wm-comment-text-size', `${value.commentTextSize ?? 16}px`);
  threadSizing.update(value);
  railResize?.update(value.railWidth);
}

function apiPath(pathname: string): string {
  return pathname.replace(/^\//, "").replace(/^api\//, "api/");
}

function compactTopBar(): void {
  const inner = editorRoot.querySelector<HTMLElement>(".top-bar-inner");
  if (!inner) return;
  let overflow = inner.querySelector<HTMLElement>(":scope > .wm-tool-overflow");
  if (!overflow) {
    overflowCleanup?.();
    overflow = document.createElement("span");
    overflow.className = "wm-tool-overflow";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "wm-overflow-trigger";
    trigger.innerHTML = iconSvg("text-aa");
    trigger.title = "More formatting tools";
    trigger.setAttribute("aria-label", trigger.title);
    trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("span");
    menu.className = "wm-tool-overflow-menu";
    menu.hidden = true;
    overflow.append(trigger, menu);
    inner.append(overflow);
    const close = (): void => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
    const toggle = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const open = menu.hidden;
      if (open) {
        const bounds = overflow!.getBoundingClientRect();
        menu.style.maxWidth = `${Math.max(160, window.innerWidth - bounds.left - 12)}px`;
      }
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    };
    const outside = (event: Event): void => {
      if (!(event.target instanceof Node) || !overflow!.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
    trigger.addEventListener("click", toggle);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    overflowCleanup = () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      overflowCleanup = null;
    };
  }
  const menu = overflow.querySelector<HTMLElement>(".wm-tool-overflow-menu")!;
  if (!menu.querySelector("[data-insert-code]")) {
    const code = document.createElement("button");
    code.type = "button";
    code.dataset.insertCode = "true";
    code.className = "wm-comment-button";
    code.innerHTML = iconSvg("code-block");
    code.title = "Insert code block";
    code.setAttribute("aria-label", code.title);
    code.addEventListener("pointerdown", event => event.preventDefault());
    code.addEventListener("click", () => {
      crepe?.editor.action(callCommand(createCodeBlockCommand.key));
      menu.hidden = true;
      overflow?.querySelector("button")?.setAttribute("aria-expanded", "false");
      getEditorView()?.focus();
    });
    menu.append(code);
  }
  const tools = [...inner.children].filter((element) => element.classList.contains("top-bar-item") || element.classList.contains("top-bar-divider"));
  if (tools.length) menu.append(...tools);
  const inlineCode = menu.querySelectorAll(".top-bar-item")[topBarLabels.indexOf("Inline code")];
  const codeBlock = menu.querySelector("[data-insert-code]")!;
  if (inlineCode && inlineCode.nextElementSibling !== codeBlock) inlineCode.after(codeBlock);
  const quote = menu.querySelectorAll(".top-bar-item")[topBarLabels.indexOf("Increase quote level")];
  if (quote && !menu.querySelector("[data-decrease-quote]")) {
    const decrease = document.createElement("button");
    decrease.type = "button";
    decrease.dataset.decreaseQuote = "true";
    decrease.className = "wm-comment-button";
    decrease.innerHTML = iconSvg("quotes");
    decrease.querySelector("svg")!.style.transform = "rotate(180deg)";
    labelIconButton(decrease, "Decrease quote level");
    decrease.addEventListener("pointerdown", event => event.preventDefault());
    decrease.addEventListener("click", () => {
      const view = getEditorView();
      if (view?.editable) decreaseQuoteLevel(view.state, view.dispatch, view);
      menu.hidden = true;
      overflow?.querySelector("button")?.setAttribute("aria-expanded", "false");
      view?.focus();
    });
    quote.before(decrease);
  }
}

function integrateToolbarControls(): void {
  const topBar = editorRoot.querySelector<HTMLElement>(".milkdown-top-bar");
  if (!topBar) return;
  topBar.append(toolbarControls);
  toolbarControls.hidden = false;
  compactTopBar();
}

const topBarLabels = ["Bold", "Italic", "Strikethrough", "Footnote", "Inline code", "Bulleted list", "Numbered list", "Task list", "Link", "Image", "Table", "Increase quote level", "Horizontal rule"];
function labelIconButton(button: HTMLButtonElement, label: string): void {
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = button.querySelector("svg");
  if (!icon) return;
  icon.removeAttribute("aria-hidden");
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", label);
}
function labelCrepeTools(): void {
  compactTopBar();
  const styleButton = editorRoot.querySelector<HTMLButtonElement>(".top-bar-heading-button");
  if (styleButton) labelIconButton(styleButton, "Block style");
  editorRoot.querySelectorAll<HTMLButtonElement>(".top-bar-item").forEach((button, index) => {
    const label = topBarLabels[index];
    if (label) labelIconButton(button, label);
  });
  document.querySelectorAll<HTMLButtonElement>(".milkdown-toolbar .toolbar-item").forEach((button) => {
    const label = button.getAttribute("aria-label") || button.title;
    if (label) labelIconButton(button, label);
  });
}

async function fetchResponse(pathname: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(apiPath(pathname), {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    credentials: "same-origin",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(apiErrorMessage(text, response.statusText)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

async function loadDocument(): Promise<DocumentResponse> {
  const response = await fetch(apiPath("api/file"), { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
  if (response.ok || response.status === 422) return await response.json() as DocumentResponse;
  const text = await response.text();
  throw new Error(text || response.statusText);
}
async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  return await (await fetchResponse(pathname, init)).json() as T;
}

function getEditorView(): EditorView | null {
  if (!crepe || crepe.editor.status !== EditorStatus.Created) return null;
  let view: EditorView | null = null;
  try { crepe.editor.action((ctx) => { view = ctx.get(editorViewCtx); }); }
  catch { return null; }
  return view;
}
function currentMarkdown(): string {
  if (sourceEditor) return sourceEditor.value;
  if (!crepe || crepe.editor.status !== EditorStatus.Created) return savedEditorMarkdown;
  try { return crepe.getMarkdown(); }
  catch { return savedEditorMarkdown; }
}
function currentContent(markdown: string): string {
  return sourceEditor ? markdown : restoreMarkdown(markdown, currentFrontmatter);
}
function setReviewControls(reviewing: boolean): void {
  nextChangeButton.hidden = previousChangeButton.hidden = !reviewing;
  if (!reviewing) reviewNavigation.reset();
  saveReviewButton.hidden = !reviewing;
  cancelReviewButton.hidden = !reviewing;
  reloadButton.hidden = reviewing;
  saveReviewButton.disabled = false;
  cancelReviewButton.disabled = false;
}
function showConflict(message = "This file changed elsewhere. Your unsaved version has not been overwritten."): void {
  conflicted = true;
  conflictMessage.textContent = message;
  conflictBar.hidden = false;
  setReviewControls(Boolean(incomingReview));
  if (saveTimer != null) clearTimeout(saveTimer);
}
function clearConflict(): void {
  conflicted = false;
  incomingReview = null;
  conflictBar.hidden = true;
  setReviewControls(false);
}
function normalizeThreads(state: AnnotationState): AnnotationThread[] {
  return (state.threads ?? []).map((thread) => ({
    id: thread.id,
    actor: thread.comment.actor,
    createdAt: thread.comment.createdAt,
    body: thread.comment.body,
    anchor: thread.comment.anchor,
    replies: thread.replies,
    resolved: thread.status === "resolved",
    orphaned: thread.orphan?.status === "orphan" || thread.orphan?.status === "ambiguous",
    seq: thread.comment.seq,
    deleted: thread.deleted,
  }));
}
function applyAnnotationState(state: AnnotationState): void {
  annotationState = state;
  annotationUi?.setState({ threads: normalizeThreads(state) });
}
async function refreshAnnotations(generation = documentGeneration, path = currentPath): Promise<void> {
  if (!path) return;
  const result = await api<AnnotationResponse>(`api/annotations?actor=${encodeURIComponent(targetActor)}`);
  if (generation !== documentGeneration || path !== currentPath) return;
  currentLedgerRevision = result.ledgerRevision;
  applyAnnotationState(result.annotations);
}

const draftPersistence = new DraftPersistence(async (mutation) => {
  await api("api/draft", mutation.method === "DELETE"
    ? { method: "DELETE" }
    : { method: "POST", body: JSON.stringify(mutation.draft) });
});
function scheduleSave(): void {
  if (readOnly || switching || initializing) return;
  void persistDraft();
  if (currentMarkdown() === savedEditorMarkdown || conflicted || incomingReview) return;
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), 600);
}
async function persistDraft(strict = false): Promise<void> {
  if (!crepe || !currentPath || switching || initializing || readOnly) return;
  const markdown = currentMarkdown();
  await draftPersistence.update({
    editorMarkdown: markdown,
    savedEditorMarkdown,
    body: currentContent(markdown),
    baseRevision: currentBodyRevision,
    scroll: canvas?.scroller.scrollTop ?? 0,
  }, strict);
}
async function save(): Promise<boolean> {
  if (!crepe || !currentPath) return true;
  if (readOnly) return false;
  if (conflicted || incomingReview) return false;
  if (saveInFlight) { saveAgain = true; return false; }
  const markdown = currentMarkdown();
  if (markdown === savedEditorMarkdown) return true;
  saveInFlight = true;
  let succeeded = true;
  try {
    const result = await api<DocumentResponse>("api/file", {
      method: "PUT",
      body: JSON.stringify({ content: currentContent(markdown), expectedBodyRevision: currentBodyRevision }),
    });
    currentBodyRevision = result.bodyRevision;
    diskBody = result.body;
    currentLedgerRevision = result.ledgerRevision;
    annotationState = result.annotations;
    savedEditorMarkdown = markdown;
    // Do not clear a newer in-flight edit's recovery draft.
    if (currentMarkdown() === markdown) await draftPersistence.clear();
  } catch (error) {
    succeeded = false;
    if ((error as Error & { status?: number }).status === 409) showConflict();
    else chrome.setNotice(`Save failed: ${(error as Error).message}`, 0);
  } finally {
    saveInFlight = false;
    if (saveAgain) { saveAgain = false; return await save(); }
  }
  return succeeded;
}
async function postAnnotation(pathname: string, body: Record<string, unknown>, generation: number, path: string): Promise<void> {
  if (generation !== documentGeneration || path !== currentPath) throw new Error("The document changed before the annotation was sent.");
  const result = await api<DocumentResponse>(pathname, { method: "POST", body: JSON.stringify({ actor: localActor, ...body }) });
  if (generation !== documentGeneration || path !== currentPath) return;
  currentLedgerRevision = result.ledgerRevision;
  await refreshAnnotations(generation, path);
}
async function openDocument(discardCurrent = false, prefetched?: DocumentResponse): Promise<void> {
  const generation = ++documentGeneration;
  if (saveTimer != null) clearTimeout(saveTimer);
  if (crepe && !discardCurrent && !(await save())) throw new Error("Resolve the current file conflict before switching files.");
  switching = true;
  clearConflict();
  try {
    const documentResponse = prefetched ?? await loadDocument();
    if (generation !== documentGeneration) return;
    sourceEditor?.destroy();
    sourceEditor = null;
    sourceButton.setAttribute('aria-pressed', 'false');
    commentButton.disabled = false;
    toolbarLabelObserver?.disconnect();
    overflowCleanup?.();
    const previousCrepe = crepe;
    crepe = null;
    selectionUi?.destroy();
    annotationUi?.destroy();
    selectionUi = null;
    annotationUi = null;
    commentButton.classList.remove("is-active");
    commentButton.setAttribute("aria-pressed", "false");
    await previousCrepe?.destroy();
    canvas?.destroy();
    canvas = null;
    editorRoot.replaceChildren();
    annotationsRoot.replaceChildren();
    currentPath = documentResponse.path;
    diskBody = documentResponse.body;
    currentBodyRevision = documentResponse.bodyRevision;
    currentLedgerRevision = documentResponse.ledgerRevision;
    annotationState = documentResponse.annotations;
    setMermaidPreviews(documentResponse.diagramPreviews, documentResponse.diagramPalette);
    ledgerReadOnly = Boolean(documentResponse.readOnly);
    readOnly = ledgerReadOnly || documentResponse.bodyEditable === false;
    fileActions.update(revealAvailable, readOnly);
    document.title = filenameStem(currentPath);
    const prepared = prepareMarkdown(documentResponse.body);
    currentFrontmatter = prepared.frontmatter;
    let insertItems: import("./selection-ui").InsertMenuItem[] = [];
    const nextSelectionUi = createSelectionUi({
      insertItems: () => insertItems,
      onNotice: (message) => chrome.setNotice(message),
      onCodeComment: (view) => {
        const anchor = captureAnchor(view, currentBodyRevision);
        if (anchor) nextAnnotationUi.openCommentComposer(anchor);
      },
    });
    let nextAnnotationUi!: AnnotationUiController;
    const nextCrepe = new Crepe({
      root: editorRoot,
      defaultValue: prepared.editorMarkdown,
      features: { [Crepe.Feature.TopBar]: true, [Crepe.Feature.BlockEdit]: false },
      featureConfigs: {
        [Crepe.Feature.CodeMirror]: { renderPreview: renderMermaidPreview, previewOnlyByDefault: true, previewLoading: "Rendering diagram…" },
        [Crepe.Feature.ImageBlock]: { proxyDomURL: imageDisplayUrl },
        [Crepe.Feature.Placeholder]: { text: "..." },
        [Crepe.Feature.TopBar]: {
          headingOptions: [
            { label: "P", level: null },
            { label: "H1", level: 1 },
            { label: "H2", level: 2 },
            { label: "H3", level: 3 },
            { label: "H4", level: 4 },
            { label: "H5", level: 5 },
            { label: "H6", level: 6 },
          ],
          buildTopBar: (builder) => {
            const names: Record<string, string> = {
              "bullet-list": "Bulleted list", "ordered-list": "Numbered list", "task-list": "Task list",
              image: "Image", table: "Table", "code-block": "Code block", math: "Math block", quote: "Blockquote", hr: "Horizontal rule",
            };
            insertItems = builder.build().flatMap(group => group.items).flatMap(item => {
              const label = names[item.key];
              if (!label || !item.onRun || !item.icon) return [];
              return [{ label, icon: item.icon, run: () => nextCrepe.editor.action(ctx => item.onRun!(ctx)) }];
            });
            insertItems.push({ label: "Footnote", icon: footnoteIcon, run: () => nextSelectionUi.openFootnote(nextCrepe.editor.ctx.get(editorViewCtx)) });
            builder.getGroup("block").clear();
            const group = builder.getGroup("formatting");
            group.addItem("footnote", { icon: footnoteIcon, active: () => false, onRun: ctx => nextSelectionUi.openFootnote(ctx.get(editorViewCtx)) });
            const item = group.group.items.pop()!;
            group.group.items.splice(group.group.items.findIndex(item => item.key === "strikethrough") + 1, 0, item);
          },
        },
        [Crepe.Feature.Toolbar]: {
          buildToolbar: (builder) => {
            builder.getGroup("function").addItem("comment", {
              icon: reviewNoteIconSvg,
              label: "Comment",
              active: () => false,
              onRun: (ctx) => {
                const view = ctx.get(editorViewCtx);
                const anchor = captureAnchor(view, currentBodyRevision);
                if (anchor) nextAnnotationUi.openCommentComposer(anchor);
              },
            });
          },
        },
      },
    });
    nextAnnotationUi = createAnnotationUi({
      root: annotationsRoot,
      sizingControl: threadSizing.root,
      editorRoot,
      getEditorView,
      onNotice: (message) => chrome.setNotice(message),
      localActor,
      onPendingCountChange: (count) => {
        pendingCount.textContent = String(count);
        pendingCount.hidden = count === 0;
        commentButton.title = count ? `Threads · ${count} ${count === 1 ? "needs" : "need"} your attention` : "Threads";
        commentButton.setAttribute("aria-label", commentButton.title);
      },
      onRailOpenChange: (open) => {
        commentButton.classList.toggle("is-active", open);
        commentButton.setAttribute("aria-pressed", String(open));
      },
      onCreateComment: async ({ body, anchor }) => {
        const annotationPath = currentPath;
        if (documentResponse.readOnly || (!readOnly && !(await save()))) throw new Error("Save the document before commenting.");
        if (generation !== documentGeneration || annotationPath !== currentPath) throw new Error("The document changed before the comment was sent.");
        const revision = currentBodyRevision;
        await postAnnotation("/api/annotations", { type: "comment", body, anchor: { ...anchor, bodyRevision: revision }, expectedBodyRevision: revision }, generation, annotationPath);
      },
      onReply: async ({ thread, body }) => postAnnotation("/api/annotations/reply", { threadId: thread.id, body }, generation, currentPath),
      onResolve: async (thread) => postAnnotation("/api/annotations/resolve", { threadId: thread.id }, generation, currentPath),
      onReopen: async (thread) => postAnnotation("/api/annotations/reopen", { threadId: thread.id }, generation, currentPath),
      onEdit: async ({ thread, targetId, body }) => postAnnotation("/api/annotations/edit", { threadId: thread.id, targetId, body }, generation, currentPath),
      onDelete: async ({ thread, targetId }) => postAnnotation("/api/annotations/delete", { threadId: thread.id, targetId }, generation, currentPath),
    });
    railResize?.destroy();
    railResize = createRailResize(document.querySelector('#workspace')!, annotationsRoot.querySelector('.wm-annotation-rail')!,
      width => api('api/preferences', { method: 'PUT', body: JSON.stringify({ railWidth: width }) }),
      error => chrome.setNotice(`Could not save threads width: ${String(error)}`));
    railResize.update(appearance.railWidth);
    const annotationPlugin = $prose(() => nextAnnotationUi.plugin);
    nextCrepe.editor.config(configureFootnotes);
    nextCrepe.editor.config(configureMarkdownSerialization);
    nextCrepe.editor.config(ctx => ctx.update(editorStateOptionsCtx, previous => options => initialReaderSelection(previous(options))));
    const completionPlugin = $prose(() => new Plugin({ view: () => ({ update() {
      if (incomingReview && !reviewSaving && !incomingDiffActive(nextCrepe.editor)) {
        queueMicrotask(() => { if (crepe === nextCrepe) void saveReviewed(); });
      }
    } }) }));
    nextCrepe.editor.use(headingAnchors).use(diagramViewer).use(footnoteOrdering).use(completionPlugin).use(nextSelectionUi.plugin).use(annotationPlugin).use(incomingDiffPlugins);
    try { await nextCrepe.create(); }
    catch (error) { nextSelectionUi.destroy(); nextAnnotationUi.destroy(); throw error; }
    crepe = nextCrepe;
    selectionUi = nextSelectionUi;
    annotationUi = nextAnnotationUi;
    const view = getEditorView();
    if (view) {
      canvas = createCanvas(view, updateNotice, updateButton);
      view.setProps({ handleScrollToSelection: scrollSelectionIntoView });
      // A fresh reader starts at the top; reading-anchor preservation is for later zooms.
      canvas.setScale(chrome.getZoom() / 100, { preserveScroll: false });
      nextAnnotationUi.attachEditorView(view);
      document.title = documentTabTitle(currentPath, view.state.doc);
    }
    integrateToolbarControls();
    labelCrepeTools();
    toolbarLabelObserver = new MutationObserver(labelCrepeTools);
    toolbarLabelObserver.observe(editorRoot, { childList: true, subtree: true });
    const editorElement = editorRoot.querySelector<HTMLElement>(".ProseMirror");
    editorElement?.setAttribute("spellcheck", "false");
    if (readOnly) { crepe.setReadonly(true); editorElement?.setAttribute("contenteditable", "false"); }
    savedEditorMarkdown = crepe.getMarkdown();
    crepe.on((listener) => listener.markdownUpdated(() => {
      const currentView = getEditorView();
      if (currentView) document.title = documentTabTitle(currentPath, currentView.state.doc);
      scheduleSave();
    }));
    applyAnnotationState(documentResponse.annotations);
    if (readOnly) {
      chrome.setNotice(documentResponse.bodyEditable === false && !documentResponse.readOnly
        ? (document.documentElement.dataset.phoneReader ? "" : "Reading and commenting. Document editing is unavailable in this session.")
        : `Read-only: ${documentResponse.ledgerError ?? "Malformed annotation ledger."}`, 0);
    } else {
      chrome.setNotice("");
    }
  } finally { if (generation === documentGeneration) switching = false; }
  if (generation !== documentGeneration) return;
  // Bootstrap already carries annotations. Network refresh belongs to the
  // reconnect loop, after the draft has been recovered and editing is enabled.
}

async function beginIncomingReview(generation = documentGeneration, path = currentPath): Promise<void> {
  if (!crepe || !currentPath || incomingReview || saveInFlight) return;
  const disk = await api<DocumentResponse>("api/file");
  if (generation !== documentGeneration || path !== currentPath) return;
  if (disk.bodyRevision === currentBodyRevision) {
    if (disk.ledgerRevision !== currentLedgerRevision) await refreshAnnotations();
    return;
  }
  if (sourceEditor) { showConflict(); return; }
  if (currentMarkdown() !== savedEditorMarkdown) { showConflict(); return; }
  const prepared = prepareMarkdown(disk.body);
  incomingReview = { bodyRevision: disk.bodyRevision, ledgerRevision: disk.ledgerRevision, frontmatter: prepared.frontmatter, body: disk.body };
  const target = startIncomingDiff(crepe.editor, prepared.editorMarkdown);
  if (!target) { incomingReview = null; showConflict(); return; }
  incomingReview.editorDoc = target;
  currentLedgerRevision = disk.ledgerRevision;
  applyAnnotationState(disk.annotations);
  showConflict("There are new changes for your review.");
  if (!incomingDiffActive(crepe.editor)) void saveReviewed();
}
let reviewSaving = false;
async function saveReviewed(): Promise<void> {
  if (!crepe || !incomingReview || reviewSaving || incomingDiffActive(crepe.editor)) return;
  reviewSaving = true;
  const generation = documentGeneration;
  const review = incomingReview;
  saveReviewButton.disabled = true;
  cancelReviewButton.disabled = true;
  try {
    const markdown = currentMarkdown();
    const result = await api<DocumentResponse>("api/file", {
      method: "PUT",
      body: JSON.stringify({ content: review.editorDoc && matchesIncomingDocument(crepe.editor, review.editorDoc) ? review.body : restoreMarkdown(markdown, review.frontmatter), expectedBodyRevision: review.bodyRevision }),
    });
    if (generation !== documentGeneration) return;
    currentFrontmatter = review.frontmatter;
    currentBodyRevision = result.bodyRevision;
    diskBody = result.body;
    currentLedgerRevision = result.ledgerRevision;
    savedEditorMarkdown = markdown;
    clearConflict();
    if (currentMarkdown() === markdown) await draftPersistence.clear();
    else scheduleSave();
    await refreshAnnotations();
  } catch (error) {
    if (generation !== documentGeneration) return;
    incomingReview = null;
    chrome.setNotice(`Reviewed save failed: ${(error as Error).message}`, 0);
    showConflict("The disk changed again during review. Reload it before continuing.");
  } finally { reviewSaving = false; }
}
async function lease(generation = documentGeneration, path = currentPath, signal?: AbortSignal): Promise<void> {
  try {
    const result = await api<{ path?: string; bodyRevision: string | null; ledgerRevision: string | null; appearanceRevision: string; preferences?: SessionBootstrap["preferences"] }>("api/changes", {
      method: "POST", body: JSON.stringify({ clientId, appearanceRevision }), signal,
    });
    if (generation !== documentGeneration || path !== currentPath) return;
    if (result.preferences) { themePicker?.update(result.preferences); applyAppearance(result.preferences); }
    appearanceRevision = result.appearanceRevision;
    if (result.path && result.path !== currentPath) {
      currentPath = result.path;
      path = result.path;
      const view = getEditorView();
      document.title = view ? documentTabTitle(currentPath, view.state.doc) : filenameStem(currentPath);
    }
    if (disconnected) { disconnected = false; chrome.setNotice(""); }
    if (!currentPath || saveInFlight) return;
    if (readOnly && result.bodyRevision && result.bodyRevision !== currentBodyRevision) {
      const disk = await loadDocument();
      if (generation !== documentGeneration || path !== currentPath || !crepe) return;
      const previous = diskBody, prepared = prepareMarkdown(disk.body);
      setMermaidPreviews(disk.diagramPreviews, disk.diagramPalette);
      switching = true;
      try {
        const changes = updateReaderBody(crepe.editor, prepared.editorMarkdown);
        currentBodyRevision = disk.bodyRevision; currentFrontmatter = prepared.frontmatter;
        diskBody = disk.body; savedEditorMarkdown = crepe.getMarkdown();
        currentLedgerRevision = disk.ledgerRevision;
        sourceEditor?.replaceBody(disk.body);
        applyAnnotationState(disk.annotations);
        changesInspector.record(previous, disk.body, changes);
      } finally { switching = false; }
      return;
    }
    if (result.ledgerRevision && result.ledgerRevision !== currentLedgerRevision) await refreshAnnotations(generation, path);
    if (result.bodyRevision && result.bodyRevision !== currentBodyRevision) await beginIncomingReview(generation, path);
  } catch (error) {
    if ((error as Error & { status?: number }).status === 422) {
      readOnly = true;
      ledgerReadOnly = true;
      if (sourceEditor) sourceEditor.setReadOnly(true);
      fileActions.update(revealAvailable, true);
      editorRoot.querySelector<HTMLElement>(".ProseMirror")?.setAttribute("contenteditable", "false");
      chrome.setNotice(`Read-only: ${(error as Error).message}`, 0);
      return;
    }
    disconnected = true;
    chrome.setNotice(`Disconnected: ${(error as Error).message}`, 0);
    throw error;
  }
}
async function start(): Promise<void> {
  const bootstrap = await api<SessionBootstrap>("api/bootstrap");
  if (bootstrap.remoteReader && !document.getElementById("phone-comment")) {
    document.documentElement.dataset.phoneReader = "true";
    const button = document.createElement("button");
    button.id = "phone-comment"; button.type = "button"; button.innerHTML = iconSvg("pen-nib");
    button.setAttribute("aria-label", "Comment on selection");
    button.title = "Comment on selection";
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => {
      const view = getEditorView();
      const anchor = view && captureAnchor(view, currentBodyRevision);
      if (anchor) annotationUi?.openCommentComposer(anchor);
      else chrome.setNotice("Select a passage first.");
    });
    button.className = "wm-comment-button";
    const controls = document.createElement("nav");
    controls.setAttribute("aria-label", "Reader comments");
    controls.className = "wm-phone-controls";
    controls.append(button, commentButton);
    document.body.append(controls);
    const mobileTheme = themeButton.closest<HTMLElement>(".wm-theme-picker")!;
    mobileTheme.classList.add("wm-phone-theme-picker");
    document.body.append(mobileTheme);
    mountMobileFolio({ list: () => api("api/folio"), beforeOpen: () => annotationUi?.setRailOpen(false) });
  }
  if (bootstrap.updateControls && !updateMounted) { mountUpdates(); updateMounted = true; }
  pageOpensLinks = bootstrap.capabilities?.pageOpensLinks === true;
  revealAvailable = bootstrap.capabilities?.revealFile === true;
  fileActions.update(revealAvailable, readOnly, bootstrap.directoryPicker === true);
  stopFind?.();
  stopFind = bootstrap.capabilities?.pageFind ? installReaderFind(getEditorView) : undefined;
  initializing = true;
  editorRoot.inert = true;
  annotationsRoot.inert = true;
  themePicker?.destroy();
  try {
    themePicker = createThemePicker(themeButton, themeMenu, editorRoot, {
      initialTheme: bootstrap.preferences.theme,
      hideInheritance: bootstrap.remoteReader,
      inheritPaseoTheme: bootstrap.preferences.inheritPaseoTheme,
      customThemes: bootstrap.preferences.customThemes,
      makerButton: bootstrap.remoteReader ? undefined : document.querySelector<HTMLButtonElement>("#theme-maker")!,
      persist: (mutation) => api("api/preferences", { method: "PUT", body: JSON.stringify(mutation) }),
      onError: (message) => chrome.setNotice(message),
    });
    applyAppearance(bootstrap.preferences);
    chrome.setZoom(bootstrap.zoom ?? 100);

    await openDocument(false, bootstrap.document as DocumentResponse);
    const draft = bootstrap.draft;
    const recovery = recoverDraft(bootstrap.document, draft);
    if (recovery && crepe) {
      const prepared = prepareMarkdown(recovery.body);
      currentFrontmatter = prepared.frontmatter;
      currentBodyRevision = recovery.baseRevision;
      if (recovery.conflicted) showConflict("Recovered draft: the file changed. Review your draft before saving or reload the file.");
      crepe.editor.action(replaceAll(prepared.editorMarkdown));
      if (!recovery.conflicted) chrome.setNotice("Recovered unsaved draft.");
    }
    // Font and canvas layout can otherwise clamp a restored position to zero.
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1000))]);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (canvas) canvas.scroller.scrollTop = bootstrap.scroll ?? draft?.scroll ?? 0;
    if (location.hash) scrollToDocumentAnchor(editorRoot, location.hash, false);
    initialized = true;
  } finally {
    initializing = false;
    editorRoot.inert = !initialized;
    annotationsRoot.inert = !initialized;
  }
}

let positionTimer: number | undefined;
function persistPosition(keepalive = false): void {
  clearTimeout(positionTimer);
  if (!initialized || initializing) return;
  void api("api/position", { method: "POST", body: JSON.stringify({ scroll: canvas?.scroller.scrollTop ?? 0, zoom: chrome.getZoom() }), keepalive }).catch(() => {});
}
addEventListener("scroll", (event) => {
  if (event.target !== canvas?.scroller) return;
  if (!initialized || initializing) return;
  clearTimeout(positionTimer);
  positionTimer = window.setTimeout(() => persistPosition(), 150);
}, { passive: true, capture: true });

commentButton.addEventListener("click", () => {
  if (!annotationUi) return;
  const open = !annotationUi.isRailOpen();
  annotationUi.setRailOpen(open);
});
sourceButton.addEventListener('click', async () => {
  sourceButton.disabled = true;
  try {
    if (!crepe || conflicted || incomingReview) { chrome.setNotice('Resolve the file conflict before switching views.'); return; }
    if (!readOnly && !(await save())) return;
    if (sourceEditor) {
      const fraction = sourceEditor.scroller.scrollTop / Math.max(1, sourceEditor.scroller.scrollHeight - sourceEditor.scroller.clientHeight);
      await openDocument(true);
      if (canvas) canvas.scroller.scrollTop = fraction * (canvas.scroller.scrollHeight - canvas.scroller.clientHeight);
      return;
    }
    const fraction = canvas ? canvas.scroller.scrollTop / Math.max(1, canvas.scroller.scrollHeight - canvas.scroller.clientHeight) : 0;
    sourceEditor = createSourceEditor(diskBody, readOnly, scheduleSave);
    savedEditorMarkdown = diskBody;
    selectionUi?.close();
    annotationUi?.setRailOpen(false);
    annotationUi?.closeFootnotePopover();
    commentButton.disabled = true;
    canvas?.shell.classList.add('wm-source-mode');
    canvas?.scroller.before(sourceEditor.dom);
    sourceEditor.scroller.scrollTop = fraction * (sourceEditor.scroller.scrollHeight - sourceEditor.scroller.clientHeight);
    sourceButton.setAttribute('aria-pressed', 'true');
    sourceEditor.focus();
  } catch (error) { chrome.setNotice(`Could not switch source view: ${(error as Error).message}`); }
  finally { sourceButton.disabled = false; }
});
reloadButton.addEventListener("click", async () => {
  await draftPersistence.clear();
  await openDocument(true);
});
async function exportReview(): Promise<void> {
  if (!(await save())) return;
  try {
    const review = await api("api/export", { method: "POST" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(review, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${filenameStem(currentPath)}.tether`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { chrome.setNotice(`Export failed: ${(error as Error).message}`, 0); }
}
saveReviewButton.addEventListener("click", () => { if (crepe && incomingReview) acceptIncomingDiff(crepe.editor); });
cancelReviewButton.addEventListener("click", () => {
  if (crepe && incomingReview) cancelIncomingDiff(crepe.editor);
});
// Hosts that turn a page's new tab into their own tab let the reader open
// documents directly, still inside the click, so no host round trip moves focus.
let pageOpensLinks = false;
editorRoot.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  const href = link?.getAttribute("href") ?? "";
  const target = localDocumentLink(href);
  const fragment = href.startsWith('#') ? href : target?.format === 'wikilink' && target.target.startsWith('#') ? linkFragment(target.target, target.format) : '';
  if (link && fragment) {
    event.preventDefault(); event.stopPropagation();
    // Scrolling within the current reader needn't navigate the host's web tab.
    if (!scrollToDocumentAnchor(editorRoot, fragment)) chrome.setNotice('That anchor was not found in this document.');
    return;
  }
  if (!link || !target) return;
  event.preventDefault();
  event.stopPropagation();
  if (pageOpensLinks && opensAsDocument(target)) {
    const opener = document.createElement("a");
    opener.href = documentLinkPath(target);
    opener.target = "_blank";
    opener.rel = "noopener";
    opener.click();
    return;
  }
  void api("api/open", {
    method: "POST",
    body: JSON.stringify(target),
  }).catch((error) => chrome.setNotice(`Could not open link: ${(error as Error).message}`, 0));
}, true);
addEventListener('hashchange', () => scrollToDocumentAnchor(editorRoot, location.hash));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
});
const connection = createReconnectLoop({
  intervalMs: 1500,
  run: async signal => {
    if (document.hidden) return;
    if (!initialized) await start();
    else await lease(documentGeneration, currentPath, signal);
    // Retry the latest editor state, not an obsolete failed draft request.
    await persistDraft();
  },
  onError: error => chrome.setNotice(`${initialized ? "Disconnected" : "Startup failed"}: ${(error as Error).message}`, 0),
});
addEventListener("pageshow", () => { if (!document.hidden) connection.wake(); });
addEventListener("online", () => { if (!document.hidden) connection.wake(); });
addEventListener("visibilitychange", () => {
  if (document.hidden) { persistPosition(true); void persistDraft(); connection.pause(); }
  else connection.wake();
});
addEventListener("pagehide", event => {
  persistPosition(true);
  connection.pause();
  const body = new Blob([JSON.stringify({ clientId })], { type: "application/json" });
  navigator.sendBeacon(apiPath("api/release"), body);
  if ((event as PageTransitionEvent).persisted) return;
  connection.dispose();
  sourceEditor?.destroy();
  selectionUi?.destroy();
  annotationUi?.destroy();
  railResize?.destroy();
  toolbarLabelObserver?.disconnect();
  overflowCleanup?.();
  themePicker?.destroy();
  chrome.destroy();
  threadSizing.destroy();
  fileActions.destroy();
});
if (!document.hidden) connection.wake();


const updateStyle = document.createElement("style");
updateStyle.textContent = updateControlStyles;
document.head.append(updateStyle);
const updateButton = document.createElement("button");
updateButton.id = "update-package";
updateButton.type = "button";
updateButton.hidden = true;
updateButton.title = "Update Available";
updateButton.setAttribute("aria-label", "Update Available");
updateButton.setAttribute("aria-expanded", "false");
updateButton.setAttribute("aria-controls", "update-notice");
updateButton.innerHTML = iconSvg("package") + '<span class="update-dot" aria-hidden="true"></span>';
const updateNotice = document.createElement("aside");
updateNotice.id = "update-notice";
updateNotice.hidden = true;
updateNotice.setAttribute("aria-live", "polite");
function mountUpdates() { mountUpdateNotice(updateNotice, new URL("api", location.href).pathname, message => chrome.setNotice(message), async () => {
  if (!initialized || initializing || switching) throw new Error("Wait for the document to finish loading.");
  await persistDraft(true);
}, false, undefined, updateButton); }
