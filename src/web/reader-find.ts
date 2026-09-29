import type { EditorView } from '@milkdown/kit/prose/view';
import { EditorView as CodeMirror } from '@codemirror/view';
import { installPageFind, type FindSource } from './page-find';

export function installReaderFind(getView: () => EditorView | null): () => void {
  return installPageFind({
    roots: () => [...document.querySelectorAll('.wm-thread-details:not([hidden]),.wm-thread-popover')].filter(node => !node.closest('[hidden],[inert]')),
    sources: () => {
      const view = getView(); if (!view) return [];
      const sources: FindSource[] = [];
      view.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        const text = node.textBetween(0, node.content.size, '', '\ufffc');
        const dom = view.nodeDOM(pos) as HTMLElement | null;
        const cm = dom?.querySelector('.cm-content');
        const code = cm ? CodeMirror.findFromDOM(cm as HTMLElement) : null;
        sources.push({ key: pos, text,
          reveal: code ? from => code.dispatch({ effects: CodeMirror.scrollIntoView(from, { y: 'center' }) }) : undefined,
          range(from, to) {
            try {
              if (code && !code.visibleRanges.some(range => from >= range.from && to <= range.to)) return null;
              const start = code ? code.domAtPos(from) : view.domAtPos(pos + 1 + from);
              const end = code ? code.domAtPos(to) : view.domAtPos(pos + 1 + to);
              const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
              return range;
            } catch { return null; }
          },
        });
        return false;
      });
      return sources;
    },
  });
}
