import { smoothScroll } from "./motion";
import { scrollViewportTop } from "./scroll-geometry";
import type { Editor } from "@milkdown/kit/core";
import { commandsCtx, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { EditorState } from '@milkdown/kit/prose/state';
import type { Node } from '@milkdown/kit/prose/model';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { normalizeFootnotes } from './footnotes';
import {
  acceptAllDiffsCmd,
  clearDiffReviewCmd,
  diff,
  diffPluginKey,
  getPendingChanges,
  startDiffReviewFromDocCmd,
} from "@milkdown/kit/plugin/diff";
import { diffComponent } from "@milkdown/components/diff";

export const incomingDiffPlugins = [...diff, ...diffComponent];

/** Compare serialized content without the editor-only caret paragraph.
 * Milkdown's paragraph serializer checks live-node identity, so serializing
 * a detached target's empty final paragraph would introduce a spurious <br>.
 */
export function matchesIncomingDocument(editor: Editor, target: Node): boolean {
  const withoutCaret = (doc: Node) => doc.lastChild?.type.name === 'paragraph' && !doc.lastChild.content.size
    ? doc.copy(doc.content.cut(0, doc.content.size - doc.lastChild.nodeSize)) : doc;
  return editor.action(ctx => {
    const serialize = ctx.get(serializerCtx);
    return serialize(withoutCaret(ctx.get(editorViewCtx).state.doc)) === serialize(withoutCaret(target));
  });
}

export function startIncomingDiff(editor: Editor, markdown: string): Node | null {
  let target: Node | null = null;
  editor.action((ctx) => {
    const parsed = ctx.get(parserCtx)(markdown);
    if (!parsed) return;
    // Compare the same shape the live editor uses: numbered, ordered footnotes
    // and its editable trailing paragraph. Neither is an authored change.
    let state = EditorState.create({ doc: parsed });
    const footnotes = normalizeFootnotes(state);
    if (footnotes) state = state.apply(footnotes);
    const trailing = ctx.get(trailingConfig.key);
    if (trailing.shouldAppend(state.doc.lastChild, state)) state = state.apply(state.tr.insert(state.doc.content.size, trailing.getNode(state)));
    if (ctx.get(commandsCtx).call(startDiffReviewFromDocCmd.key, state.doc)) target = state.doc;
  });
  return target;
}

export function incomingDiffActive(editor: Editor): boolean {
  let active = false;
  editor.action((ctx) => {
    active = Boolean(diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active);
  });
  return active;
}

export function cancelIncomingDiff(editor: Editor): boolean {
  let cleared = false;
  editor.action((ctx) => {
    cleared = ctx.get(commandsCtx).call(clearDiffReviewCmd.key);
  });
  return cleared;
}

export function acceptIncomingDiff(editor: Editor): void {
  editor.action(ctx => { ctx.get(commandsCtx).call(acceptAllDiffsCmd.key); });
}

/** Stable new-document ranges survive individual decisions and recomputation. */
export function createIncomingNavigator(getView: () => import('@milkdown/kit/prose/view').EditorView | null) {
  let current: { fromB: number; toB: number } | undefined;
  return {
    reset() { current = undefined; },
    move(direction: 1 | -1) {
      const view = getView();
      if (!view) return;
      const state = diffPluginKey.getState(view.state);
      if (!state?.active) { current = undefined; return; }
      const changes = getPendingChanges(state);
      if (!changes.length) return;
      const lane = view.dom.closest<HTMLElement>('.wm-document-scroll');
      if (!lane) return;
      const viewportTop = scrollViewportTop(lane, lane.getBoundingClientRect().top) + 8;
      const location = (change: typeof changes[number]) => {
        let source: Element = view.dom;
        let rect = view.coordsAtPos(change.fromA);
        // Insertions are widgets, which can begin before coordsAtPos at the
        // same model position. Resolve their model anchor, not their DOM index.
        for (const element of view.dom.querySelectorAll<HTMLElement>('.milkdown-diff-added')) {
          const pos = view.posAtDOM(element, 0);
          if (pos >= change.fromA && pos <= change.toA) {
            const box = element.getBoundingClientRect();
            if (box.height && box.top <= rect.top) { rect = box; source = element; }
          }
        }
        if (source === view.dom) {
          const node = view.domAtPos(change.fromA).node;
          source = node instanceof Element ? node : node.parentElement!;
        }
        return { rect, source };
      };
      let index: number;
      if (current) {
        const exact = changes.findIndex(c => c.fromB === current!.fromB && c.toB === current!.toB);
        if (exact >= 0) index = (exact + direction + changes.length) % changes.length;
        else if (direction === 1) { index = changes.findIndex(c => c.fromB >= current!.fromB); if (index < 0) index = 0; }
        else { index = changes.reduce((last, c, i) => c.fromB <= current!.fromB ? i : last, -1); if (index < 0) index = changes.length - 1; }
      } else {
        index = direction === 1 ? changes.findIndex(c => location(c).rect.top >= viewportTop - 1)
          : changes.reduce((last, c, i) => location(c).rect.top < viewportTop - 1 ? i : last, -1);
        if (index < 0) index = direction === 1 ? 0 : changes.length - 1;
      }
      const change = changes[index]!;
      current = { fromB: change.fromB, toB: change.toB };
      const target = location(change);
      // Reveal nested horizontal lanes before measuring the final vertical destination.
      let node = target.source as HTMLElement | null;
      while (node && node !== lane) {
        if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) {
          const box = node.getBoundingClientRect(), scale = box.width / node.offsetWidth || 1;
          node.scrollLeft += Math.min(0, target.rect.left - box.left) / scale + Math.max(0, target.rect.right - box.right) / scale;
        }
        node = node.parentElement;
      }
      smoothScroll(lane, lane.scrollTop + location(change).rect.top - viewportTop);
    },
  };
}
