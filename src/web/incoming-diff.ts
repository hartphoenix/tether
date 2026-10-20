import { reviewActionSvg } from './icons';
import { smoothScroll } from "./motion";
import { scrollViewportTop } from "./scroll-geometry";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { EditorState, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { DOMSerializer, type Node } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import { ChangeSet } from '@milkdown/kit/prose/changeset';
import { $prose } from '@milkdown/kit/utils';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { computeDocDiff } from "@milkdown/kit/plugin/diff";
import { normalizeFootnotes } from './footnotes';

/**
 * Incoming-change review. When the file changes on disk, the editor adopts the
 * new document and keeps the reader's prior version as a baseline. Changes
 * between the two are grouped into hunks and drawn over the current text:
 * inserted words in their author's color, a margin line beside each hunk, and
 * the earlier wording available in place. Marking a hunk seen moves the
 * baseline forward; reverting it moves the document back. Either way the
 * editor's document stays the file on disk, so comments and saves work as usual.
 */

export type Range = { fromA: number; toA: number; fromB: number; toB: number };
export type Hunk = Range & {
  /** Single-textblock hunks render inline; others expand to whole top-level blocks. */
  inline: boolean;
  changes: readonly Range[];
};
export type AuthorSpan = { from: number; to: number; authorId: string | null };
export type ReviewState = {
  base: Node;
  baseRevision: string;
  changes: readonly Range[];
  hunks: readonly Hunk[];
  /** Document positions inside hunks the reader has turned to their earlier wording. */
  before: readonly number[];
  authors: readonly AuthorSpan[] | null;
};
type Action =
  | { type: 'start'; base: Node; baseRevision: string }
  | { type: 'seen'; hunk: Hunk }
  | { type: 'revert'; hunk: Hunk }
  | { type: 'toggle'; positions: number[] }
  | { type: 'authors'; spans: AuthorSpan[] | null }
  | { type: 'end' };

export const reviewKey = new PluginKey<ReviewState | null>('TETHER_CHANGE_REVIEW');
const reviewCursors = Object.fromEntries(Object.entries(reviewActionSvg).map(([action, source]) => {
  const svg = source.replace('<svg ', '<svg width="32" height="32" ')
    .replaceAll('currentColor', '#222').replace(/(<svg[^>]*>)/, '$1<circle cx="128" cy="128" r="104" fill="white"/>');
  return [action, `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, pointer`];
}));
const MAX_GAP_WORDS = 4;
const IGNORE = { ignoreAttrs: { heading: ['id'] } };

/** Group changes that sit within a few words of each other in the same block, or that abut across blocks. */
export function groupHunks(base: Node, doc: Node, changes: readonly Range[]): Hunk[] {
  const hunks: (Hunk & { changes: Range[] })[] = [];
  for (const change of changes) {
    const last = hunks.at(-1);
    if (last && closeEnough(doc, last.toB, change.fromB) && closeEnough(base, last.toA, change.fromA)) {
      last.toA = Math.max(last.toA, change.toA); last.toB = Math.max(last.toB, change.toB);
      last.changes.push(change);
    } else hunks.push({ ...change, inline: false, changes: [change] });
  }
  for (const hunk of hunks) {
    hunk.inline = withinTextblock(base, hunk.fromA, hunk.toA) && withinTextblock(doc, hunk.fromB, hunk.toB);
    if (!hunk.inline) continue;
    // Widen to whole words. The added characters are unchanged text, so both sides widen alike.
    const words = snapToWords(doc, hunk.fromB, hunk.toB);
    hunk.fromA -= hunk.fromB - words.from; hunk.toA += words.to - hunk.toB;
    hunk.fromB = words.from; hunk.toB = words.to;
  }
  return hunks;
}
function closeEnough(doc: Node, from: number, to: number): boolean {
  if (to <= from) return true;
  const words = doc.textBetween(from, to, ' ', ' ').split(/\s+/).filter(Boolean).length;
  if (words === 0) return true;
  const $from = doc.resolve(from), $to = doc.resolve(to);
  return words <= MAX_GAP_WORDS && $from.parent === $to.parent && $from.parent.isTextblock;
}
function withinTextblock(doc: Node, from: number, to: number): boolean {
  const $from = doc.resolve(from), $to = doc.resolve(to);
  return $from.depth > 0 && $from.parent === $to.parent && $from.parent.isTextblock;
}
/** Top-level block boundaries around a range. */
export function blockRange(doc: Node, from: number, to: number): { from: number; to: number } {
  const $from = doc.resolve(from), $to = doc.resolve(to);
  const start = $from.depth ? $from.before(1) : from;
  let end = $to.depth ? $to.after(1) : to;
  if (end === start && $to.nodeAfter) end = start + $to.nodeAfter.nodeSize;
  return { from: start, to: end };
}
const wordChar = /[\p{L}\p{N}_'’-]/u;
/** Widen a range within a textblock to whole words, so "The" → "Two" never renders as T + wo. */
export function snapToWords(doc: Node, from: number, to: number): { from: number; to: number } {
  if (!withinTextblock(doc, from, to)) return { from, to };
  const $from = doc.resolve(from);
  const start = $from.start(), text = $from.parent.textBetween(0, $from.parent.content.size, undefined, '￼');
  const word = (index: number) => index >= 0 && index < text.length && wordChar.test(text[index]!);
  let a = from - start, b = to - start;
  if (a === b) return { from, to };
  while (word(a - 1) && word(a)) a--;
  while (word(b) && word(b - 1)) b++;
  return { from: start + a, to: start + b };
}

function compute(base: Node, doc: Node): Pick<ReviewState, 'changes' | 'hunks'> {
  const changes = computeDocDiff(base, doc, IGNORE).map(({ fromA, toA, fromB, toB }) => ({ fromA, toA, fromB, toB }));
  return { changes, hunks: groupHunks(base, doc, changes) };
}
export function showsBefore(state: ReviewState, hunk: Hunk): boolean {
  return state.before.some(pos => pos >= hunk.fromB && pos <= hunk.toB);
}

function applyChanges(tr: Transform, target: Node, changes: readonly Range[]): Transform {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]!;
    tr.replace(change.fromA, change.toA, target.slice(change.fromB, change.toB));
  }
  if (!tr.doc.eq(target)) tr.replaceWith(0, tr.doc.content.size, target.content);
  return tr;
}

export const reviewPlugin = new Plugin<ReviewState | null>({
  key: reviewKey,
  state: {
    init: () => null,
    apply(tr, value, _old, next): ReviewState | null {
      const action = tr.getMeta(reviewKey) as Action | undefined;
      if (action?.type === 'end') return null;
      if (action?.type === 'start') {
        const base = value?.base ?? action.base;
        const computed = compute(base, next.doc);
        return computed.hunks.length ? { base, baseRevision: value?.baseRevision ?? action.baseRevision, ...computed, before: [], authors: null } : null;
      }
      if (!value) return null;
      let state: ReviewState = value;
      if (tr.docChanged) state = {
        ...state, ...compute(state.base, next.doc),
        before: state.before.map(pos => tr.mapping.map(pos)),
        authors: state.authors?.map(span => ({ ...span, from: tr.mapping.map(span.from, 1), to: tr.mapping.map(span.to, -1) })).filter(span => span.to > span.from) ?? null,
      };
      if (action?.type === 'seen') {
        const hunk = action.hunk;
        const base = new Transform(state.base).replace(hunk.fromA, hunk.toA, next.doc.slice(hunk.fromB, hunk.toB)).doc;
        state = { ...state, base, ...compute(base, next.doc) };
      } else if (action?.type === 'toggle') {
        const before = new Set(state.before);
        for (const pos of action.positions) {
          const hunk = state.hunks.find(h => pos >= h.fromB && pos <= h.toB);
          if (!hunk) continue;
          if (showsBefore(state, hunk)) { for (const p of [...before]) if (p >= hunk.fromB && p <= hunk.toB) before.delete(p); }
          else before.add(hunk.fromB);
        }
        state = { ...state, before: [...before] };
      } else if (action?.type === 'authors') state = { ...state, authors: action.spans };
      return state.hunks.length ? state : null;
    },
  },
  filterTransaction(tr, state) {
    // Review shows the file on disk; only review actions change it until review ends.
    return !(reviewKey.getState(state) && tr.docChanged && !tr.getMeta(reviewKey));
  },
  props: {
    decorations(state) {
      const review = reviewKey.getState(state);
      return review ? buildDecorations(state.doc, review) : DecorationSet.empty;
    },
  },
  view(view) { return new MarginLines(view); },
});

/** Reader-supplied identity colors; undefined means the human or an unknown author. */
let colorFor: (authorId: string | null) => string | undefined = () => undefined;
export function setReviewColors(lookup: typeof colorFor): void { colorFor = lookup; }
const NEUTRAL = 'var(--wm-color-primary, #735b45)';

export function hunkColor(state: ReviewState, hunk: Hunk): string {
  if (!state.authors) return NEUTRAL;
  const found = new Set<string | null>();
  for (const span of state.authors) if (span.from < Math.max(hunk.toB, hunk.fromB + 1) && span.to > hunk.fromB) found.add(span.authorId);
  return found.size === 1 ? colorFor([...found][0]!) ?? NEUTRAL : NEUTRAL;
}
/** Expand only display coverage; the revision chain keeps exact character ownership. */
function wordAuthors(doc: Node, spans: readonly AuthorSpan[]): AuthorSpan[] {
  const expanded: AuthorSpan[] = [];
  for (const span of spans) doc.nodesBetween(span.from, span.to, (node, pos) => {
    if (!node.isTextblock) return true;
    const from = Math.max(span.from, pos + 1), to = Math.min(span.to, pos + 1 + node.content.size);
    if (to > from) expanded.push({ ...snapToWords(doc, from, to), authorId: span.authorId });
    return false;
  });
  return expanded;
}
/** A word with several contributing authors stays neutral, rather than striped. */
function coloredPieces(authors: readonly AuthorSpan[] | null, from: number, to: number): { from: number; to: number; color: string }[] {
  if (!authors) return [{ from, to, color: NEUTRAL }];
  const cuts = new Set([from, to]);
  for (const span of authors) { if (span.from > from && span.from < to) cuts.add(span.from); if (span.to > from && span.to < to) cuts.add(span.to); }
  const points = [...cuts].sort((a, b) => a - b), pieces = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    const contributors = new Set(authors.filter(span => span.from < b && span.to > a).map(span => span.authorId));
    const author = contributors.size === 1 ? [...contributors][0]! : null;
    pieces.push({ from: a, to: b, color: colorFor(author) ?? NEUTRAL });
  }
  return pieces;
}

function buildDecorations(doc: Node, state: ReviewState): DecorationSet {
  const decorations: Decoration[] = [];
  const authors = state.authors ? wordAuthors(doc, state.authors) : null;
  for (const hunk of state.hunks) {
    if (showsBefore(state, hunk)) {
      const hidden = hunk.inline ? { from: hunk.fromB, to: hunk.toB } : blockRange(doc, hunk.fromB, hunk.toB);
      if (hunk.inline) { if (hidden.to > hidden.from) decorations.push(Decoration.inline(hidden.from, hidden.to, { class: 'tether-review-hidden' })); }
      else doc.nodesBetween(hidden.from, hidden.to, (node, pos) => { if (pos >= hidden.from && pos + node.nodeSize <= hidden.to) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'tether-review-hidden' })); return false; });
      const baseRange = hunk.inline ? { from: hunk.fromA, to: hunk.toA } : blockRange(state.base, hunk.fromA, hunk.toA);
      const deleted = hunk.changes.filter(change => change.toA > change.fromA).map(change => snapToWords(state.base, change.fromA, change.toA));
      decorations.push(Decoration.widget(hidden.from, () => renderBefore(state.base, baseRange.from, baseRange.to, deleted, hunk.inline, hunk.fromB),
        { side: -1, key: `before-${hunk.fromB}-${hunk.fromA}-${hunk.toA}`, ignoreSelection: true }));
      continue;
    }
    for (const change of hunk.changes) {
      if (change.toB <= change.fromB) continue;
      const range = snapToWords(doc, change.fromB, change.toB);
      for (const piece of coloredPieces(authors, range.from, range.to)) {
        const attrs = { class: 'tether-review-inserted', style: `--tether-review-color: ${piece.color}` };
        decorations.push(Decoration.inline(piece.from, piece.to, attrs));
        // Atoms and code blocks don't take inline styling; mark the whole node.
        doc.nodesBetween(piece.from, piece.to, (node, pos) => {
          if (pos < piece.from || pos + node.nodeSize > piece.to) return true;
          if (node.type.spec.code || node.isBlock && node.isAtom) { decorations.push(Decoration.node(pos, pos + node.nodeSize, { ...attrs, class: 'tether-review-inserted-block' })); return false; }
          return true;
        });
      }
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** Earlier wording, with the words the change removed drawn as ghosts. */
export function renderBefore(base: Node, from: number, to: number, deleted: readonly { from: number; to: number }[], inline: boolean, anchor: number): HTMLElement {
  const serializer = DOMSerializer.fromSchema(base.type.schema);
  const wrap = document.createElement(inline ? 'span' : 'div');
  wrap.className = inline ? 'tether-review-before' : 'tether-review-before tether-review-before-block';
  wrap.dataset.hunk = String(anchor);
  wrap.contentEditable = 'false';
  const isDeleted = (a: number, b: number) => deleted.some(range => range.from <= a && range.to >= b);
  const inlineRun = (parent: Node, start: number, a: number, b: number): DocumentFragment => {
    const out = document.createDocumentFragment();
    const cuts = new Set([a, b]);
    for (const range of deleted) { if (range.from > a && range.from < b) cuts.add(range.from); if (range.to > a && range.to < b) cuts.add(range.to); }
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i < points.length - 1; i++) {
      const [x, y] = [points[i]!, points[i + 1]!];
      const piece = serializer.serializeFragment(parent.content.cut(x - start, y - start));
      if (isDeleted(x, y)) { const ghost = document.createElement('span'); ghost.className = 'tether-review-ghost'; ghost.append(piece); out.append(ghost); }
      else out.append(piece);
    }
    return out;
  };
  if (inline) {
    const $from = base.resolve(from);
    if (to > from) wrap.append(inlineRun($from.parent, $from.start(), from, to));
    return wrap;
  }
  const renderNode = (node: Node, pos: number): globalThis.Node => {
    const spec = serializer.nodes[node.type.name];
    if (node.isTextblock && spec) {
      const { dom, contentDOM } = DOMSerializer.renderSpec(document, spec(node));
      (contentDOM ?? dom as HTMLElement).append(inlineRun(node, pos + 1, pos + 1, pos + 1 + node.content.size));
      return dom;
    }
    if (node.isLeaf || !spec) {
      const dom = serializer.serializeNode(node);
      if (isDeleted(pos, pos + node.nodeSize) && dom instanceof HTMLElement) dom.classList.add('tether-review-ghost');
      return dom;
    }
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, spec(node));
    node.forEach((child, offset) => (contentDOM ?? dom as HTMLElement).append(renderNode(child, pos + 1 + offset)));
    return dom;
  };
  base.nodesBetween(from, to, (node, pos) => { wrap.append(renderNode(node, pos)); return false; });
  return wrap;
}

/** One line layer per editor, shared by successive plugin views when the state is reconfigured. */
const layers = new WeakMap<HTMLElement, { layer: HTMLElement; owners: number }>();

/** A thin line in the page margin beside each hunk, in its author's color. Clicking it marks the hunk seen. */
class MarginLines {
  private frame = 0;
  private readonly observer: ResizeObserver | null;
  constructor(private view: EditorView) {
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    this.observer?.observe(view.dom);
    this.schedule();
  }
  update(view: EditorView) { this.view = view; this.schedule(); }
  destroy() {
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    const shared = layers.get(this.view.dom);
    if (shared && this.owns && --shared.owners === 0) { shared.layer.remove(); layers.delete(this.view.dom); }
  }
  private owns = false;
  private layer(parent: HTMLElement): HTMLElement {
    let shared = layers.get(this.view.dom);
    if (!shared) { const layer = document.createElement('div'); layer.className = 'tether-review-lines'; shared = { layer, owners: 0 }; layers.set(this.view.dom, shared); }
    if (!this.owns) { this.owns = true; shared.owners++; }
    if (shared.layer.parentElement !== parent) parent.append(shared.layer);
    return shared.layer;
  }
  private schedule() {
    if (typeof requestAnimationFrame === 'undefined') return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }
  private draw() {
    const { view } = this;
    const state = reviewKey.getState(view.state);
    const parent = view.dom.parentElement;
    if (!parent) return;
    const layer = this.layer(parent);
    if (!state) { layer.replaceChildren(); return; }
    const box = parent.getBoundingClientRect(), scale = box.width / (parent.offsetWidth || box.width) || 1;
    const left = view.dom.offsetLeft + parseFloat(getComputedStyle(view.dom).paddingLeft || '0') - 18;
    // Reuse line elements so a line under the pointer survives unrelated updates.
    const lines = [...layer.children] as HTMLButtonElement[];
    let used = 0;
    for (const hunk of state.hunks) {
      const extent = hunkExtent(view, state, hunk);
      if (!extent) continue;
      const before = showsBefore(state, hunk);
      let line = lines[used];
      if (!line) {
        line = document.createElement('button');
        line.type = 'button';
        line.addEventListener('click', event => {
          event.preventDefault();
          const state = reviewKey.getState(this.view.state);
          const current = state?.hunks.find(h => h.fromB === Number(line!.dataset.hunk));
          if (state && current) {
            if (showsBefore(state, current)) revertHunk(this.view, current);
            else markHunkSeen(this.view, current);
          }
        });
        layer.append(line);
      }
      used++;
      line.dataset.hunk = String(hunk.fromB);
      line.className = 'tether-review-line' + (before ? ' is-before' : '');
      line.style.cssText = `top:${(extent.top - box.top) / scale}px;height:${Math.max(extent.bottom - extent.top, 8) / scale}px;left:${left}px;--tether-review-color:${hunkColor(state, hunk)}`;
      line.title = before ? 'Click to revert change' : 'Click to mark as seen';
      line.style.cursor = reviewCursors[before ? 'revert' : 'seen'];
      line.setAttribute('aria-label', line.title);
    }
    for (const extra of lines.slice(used)) extra.remove();
  }
}
/** Viewport rectangle a hunk occupies, whichever wording it shows. */
export function hunkExtent(view: EditorView, state: ReviewState, hunk: Hunk): { top: number; bottom: number } | null {
  try {
    if (showsBefore(state, hunk)) {
      const widget = view.dom.querySelector<HTMLElement>(`.tether-review-before[data-hunk="${hunk.fromB}"]`);
      if (widget) {
        const rects = [...widget.getClientRects()];
        if (rects.length) return { top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) };
      }
    }
    if (!hunk.inline) {
      const range = blockRange(view.state.doc, hunk.fromB, hunk.toB);
      let first: number | null = null, last: number | null = null;
      view.state.doc.nodesBetween(range.from, range.to, (_node, pos) => { first ??= pos; last = pos; return false; });
      const top = first === null ? null : view.nodeDOM(first), bottom = last === null ? null : view.nodeDOM(last);
      if (top instanceof HTMLElement && bottom instanceof HTMLElement) return { top: top.getBoundingClientRect().top, bottom: bottom.getBoundingClientRect().bottom };
    }
    const start = view.coordsAtPos(hunk.fromB, 1), end = view.coordsAtPos(hunk.toB, -1);
    return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
  } catch { return null; }
}

// Commands -------------------------------------------------------------

function viewOf(editor: Editor): EditorView { return editor.action(ctx => ctx.get(editorViewCtx)); }
export function reviewState(view: EditorView): ReviewState | null { return reviewKey.getState(view.state) ?? null; }
export function incomingDiffActive(editor: Editor): boolean { return Boolean(reviewState(viewOf(editor))); }

/** Parse disk Markdown into the same shape the live editor holds: numbered footnotes and its trailing paragraph. */
export function parseIncomingDocument(editor: Editor, markdown: string): Node | null {
  return editor.action(ctx => {
    const parsed = ctx.get(parserCtx)(markdown);
    if (!parsed) return null;
    let state = EditorState.create({ doc: parsed });
    const footnotes = normalizeFootnotes(state);
    if (footnotes) state = state.apply(footnotes);
    const trailing = ctx.get(trailingConfig.key);
    if (trailing.shouldAppend(state.doc.lastChild, state)) state = state.apply(state.tr.insert(state.doc.content.size, trailing.getNode(state)));
    return state.doc;
  });
}

/**
 * Adopt `markdown` as the editor's document and review what changed from the
 * reader's current version. An active review keeps its baseline, so changes
 * that arrive mid-review join it. Returns the adopted document, or null.
 */
export function startIncomingDiff(editor: Editor, markdown: string, baseRevision = ''): Node | null {
  const target = parseIncomingDocument(editor, markdown);
  if (!target) return null;
  const view = viewOf(editor);
  if (target.type !== view.state.doc.type) return null;
  const current = view.state.doc;
  const tr = view.state.tr;
  applyChanges(tr, target, computeDocDiff(current, target, IGNORE));
  view.dispatch(tr.setMeta(reviewKey, { type: 'start', base: current, baseRevision } satisfies Action).setMeta('addToHistory', false));
  return view.state.doc;
}
/** Compare serialized content without the editor-only caret paragraph. */
export function matchesIncomingDocument(editor: Editor, target: Node): boolean {
  const withoutCaret = (doc: Node) => doc.lastChild?.type.name === 'paragraph' && !doc.lastChild.content.size
    ? doc.copy(doc.content.cut(0, doc.content.size - doc.lastChild.nodeSize)) : doc;
  return editor.action(ctx => {
    const serialize = ctx.get(serializerCtx);
    return serialize(withoutCaret(ctx.get(editorViewCtx).state.doc)) === serialize(withoutCaret(target));
  });
}
/** Finish review: every remaining hunk counts as seen. */
export function endIncomingDiff(view: EditorView): void {
  if (reviewState(view)) view.dispatch(view.state.tr.setMeta(reviewKey, { type: 'end' } satisfies Action));
}
/** Restore only changes still under review; seen hunks are already in the baseline. */
export function revertAllHunks(view: EditorView): void {
  const state = reviewState(view);
  if (!state) return;
  const tr = view.state.tr;
  applyChanges(tr, state.base, computeDocDiff(view.state.doc, state.base, IGNORE));
  view.dispatch(tr.setMeta(reviewKey, { type: 'end' } satisfies Action));
}
export function markHunkSeen(view: EditorView, hunk: Hunk): void {
  view.dispatch(view.state.tr.setMeta(reviewKey, { type: 'seen', hunk } satisfies Action));
}
/** Put the hunk's earlier wording back into the document. The reader saves it like any edit. */
export function revertHunk(view: EditorView, hunk: Hunk): void {
  const state = reviewState(view);
  if (!state) return;
  view.dispatch(view.state.tr.replace(hunk.fromB, hunk.toB, state.base.slice(hunk.fromA, hunk.toA)).setMeta(reviewKey, { type: 'revert', hunk } satisfies Action));
}
export function toggleHunks(view: EditorView, hunks: readonly Hunk[]): void {
  if (hunks.length) view.dispatch(view.state.tr.setMeta(reviewKey, { type: 'toggle', positions: hunks.map(hunk => hunk.fromB) } satisfies Action));
}
export function setReviewAuthors(view: EditorView, spans: AuthorSpan[] | null): void {
  if (reviewState(view)) view.dispatch(view.state.tr.setMeta(reviewKey, { type: 'authors', spans } satisfies Action));
}
/** The hunk at a document position, including a block hunk anywhere in its blocks. */
export function hunkAtPos(view: EditorView, pos: number): Hunk | undefined {
  const state = reviewState(view);
  if (!state) return undefined;
  return state.hunks.find(hunk => pos >= hunk.fromB && pos <= hunk.toB)
    ?? state.hunks.find(hunk => { if (hunk.inline) return false; const range = blockRange(view.state.doc, hunk.fromB, hunk.toB); return pos >= range.from && pos <= range.to; });
}
/** The hunk under a pointer, checking rendered earlier wording first. */
export function hunkAtPoint(view: EditorView, x: number, y: number, target?: EventTarget | null): Hunk | undefined {
  const state = reviewState(view);
  if (!state) return undefined;
  const before = target instanceof Element ? target.closest<HTMLElement>('.tether-review-before') : null;
  if (before?.dataset.hunk) { const hunk = state.hunks.find(h => h.fromB === Number(before.dataset.hunk)); if (hunk) return hunk; }
  const found = view.posAtCoords({ left: x, top: y });
  if (!found) return undefined;
  return hunkAtPos(view, found.pos) ?? (found.inside >= 0 ? hunkAtPos(view, found.inside) : undefined);
}
/** Range to select and quote when commenting on a hunk; a pure deletion falls back to its block. */
export function hunkCommentRange(view: EditorView, hunk: Hunk): { from: number; to: number } {
  const doc = view.state.doc;
  const range = hunk.inline ? snapToWords(doc, hunk.fromB, hunk.toB) : { from: hunk.fromB, to: hunk.toB };
  if (doc.textBetween(range.from, range.to, ' ', ' ').trim()) return range;
  const $pos = doc.resolve(Math.min(hunk.fromB, doc.content.size));
  if ($pos.parent.isTextblock && $pos.parent.textContent.trim()) return { from: $pos.start(), to: $pos.end() };
  const block = blockRange(doc, hunk.fromB, hunk.toB);
  let found: { from: number; to: number } | null = null;
  doc.nodesBetween(Math.max(0, block.from - 1), Math.min(doc.content.size, block.to + 1), (node, pos) => {
    if (!found && node.isTextblock && node.textContent.trim()) found = { from: pos + 1, to: pos + 1 + node.content.size };
    return !found;
  });
  return found ?? range;
}
export function hunkBeforeText(view: EditorView, hunk: Hunk): string {
  const state = reviewState(view);
  if (!state) return '';
  const range = hunk.inline ? snapToWords(state.base, hunk.fromA, hunk.toA) : { from: hunk.fromA, to: hunk.toA };
  return state.base.textBetween(range.from, range.to, '\n', '￼').trim();
}
export function selectRange(view: EditorView, range: { from: number; to: number }): void {
  try { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to))); } catch { /* selection is cosmetic */ }
}

/** Steps between hunks; seen hunks drop out of the list. */
export function createIncomingNavigator(getView: () => EditorView | null) {
  let current: number | undefined;
  return {
    reset() { current = undefined; },
    move(direction: 1 | -1) {
      const view = getView();
      if (!view) return;
      const state = reviewState(view);
      if (!state) { current = undefined; return; }
      const hunks = state.hunks;
      const lane = view.dom.closest<HTMLElement>('.wm-document-scroll');
      if (!lane || !hunks.length) return;
      const viewportTop = scrollViewportTop(lane, lane.getBoundingClientRect().top) + 8;
      const top = (hunk: Hunk) => hunkExtent(view, state, hunk)?.top ?? view.coordsAtPos(hunk.fromB).top;
      let index: number;
      if (current !== undefined) {
        if (direction === 1) { index = hunks.findIndex(h => h.fromB > current!); if (index < 0) index = 0; }
        else { index = hunks.reduce((last, h, i) => h.fromB < current! ? i : last, -1); if (index < 0) index = hunks.length - 1; }
      } else {
        index = direction === 1 ? hunks.findIndex(h => top(h) >= viewportTop - 1) : hunks.reduce((last, h, i) => top(h) < viewportTop - 1 ? i : last, -1);
        if (index < 0) index = direction === 1 ? 0 : hunks.length - 1;
      }
      const hunk = hunks[index]!;
      current = hunk.fromB;
      // Reveal nested horizontal lanes before measuring the final vertical destination.
      const rect = view.coordsAtPos(hunk.fromB);
      let node: HTMLElement | null = (() => { try { const at = view.domAtPos(hunk.fromB).node; return at instanceof HTMLElement ? at : at.parentElement; } catch { return null; } })();
      while (node && node !== lane) {
        if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) {
          const box = node.getBoundingClientRect(), scale = box.width / node.offsetWidth || 1;
          node.scrollLeft += Math.min(0, rect.left - box.left) / scale + Math.max(0, rect.right - box.right) / scale;
        }
        node = node.parentElement;
      }
      smoothScroll(lane, lane.scrollTop + top(hunk) - viewportTop);
    },
  };
}

/**
 * Two quick secondary clicks near the same point, or two quick two-finger
 * taps, form a pair. On a Mac trackpad a two-finger tap arrives as a
 * contextmenu event, so the second event of a pair toggles earlier wording.
 */
export function createDoubleSecondaryTap(interval = 450, distance = 32) {
  let last: { time: number; x: number; y: number } | null = null;
  return (x: number, y: number, time = performance.now()): boolean => {
    const paired = Boolean(last && time - last.time <= interval && Math.hypot(x - last.x, y - last.y) <= distance);
    last = paired ? null : { time, x, y };
    return paired;
  };
}

/** Attribute each inserted position in the final document to the revision that wrote it. */
export function attributeRevisions(base: Node, docs: readonly { doc: Node; authorId: string | null }[]): AuthorSpan[] {
  let set = ChangeSet.create<string | null>(base, (a, b) => a === b ? a : b);
  let previous = base;
  for (const { doc, authorId } of docs) {
    const tr = applyChanges(new Transform(previous), doc, computeDocDiff(previous, doc, IGNORE));
    set = set.addSteps(tr.doc, tr.mapping.maps, authorId);
    previous = doc;
  }
  const spans: AuthorSpan[] = [];
  for (const change of set.changes) {
    let pos = change.fromB;
    for (const span of change.inserted) { spans.push({ from: pos, to: pos + span.length, authorId: span.data }); pos += span.length; }
  }
  return spans;
}
export type RevisionChain = {
  base: { bodyRevision: string; body: string } | null;
  revisions: { bodyRevision: string; parentRevision?: string | null; authorId: string | null; body: string }[];
};
/** Turn the daemon's revision chain into author spans over the editor's document, or null if it can't line up. */
export function authorsFromChain(editor: Editor, chain: RevisionChain, toMarkdown: (body: string) => string): AuthorSpan[] | null {
  if (!chain.base || !chain.revisions.length) return null;
  const parse = (body: string) => parseIncomingDocument(editor, toMarkdown(body));
  const base = parse(chain.base.body);
  if (!base) return null;
  const docs: { doc: Node; authorId: string | null }[] = [];
  let parent = chain.base.bodyRevision;
  for (const revision of chain.revisions) {
    const doc = parse(revision.body);
    if (!doc) return null;
    // A gap in the chain is an edit nobody signed.
    if (revision.parentRevision && revision.parentRevision !== parent) docs.push({ doc, authorId: null });
    else docs.push({ doc, authorId: revision.authorId });
    parent = revision.bodyRevision;
  }
  if (!docs.at(-1)!.doc.eq(viewOf(editor).state.doc)) return null;
  return attributeRevisions(base, docs);
}

export const incomingDiffPlugins = [$prose(() => reviewPlugin)];
