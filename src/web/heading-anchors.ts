import GithubSlugger from 'github-slugger';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node } from '@milkdown/kit/prose/model';
import { $prose } from '@milkdown/kit/utils';

/** DOM-only IDs leave authored Markdown and editor history untouched. */
export function headingAnchorDecorations(doc: Node): DecorationSet {
  const slugger = new GithubSlugger();
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    let text = '';
    node.descendants(child => { text += child.isText ? child.text : child.type.name === 'image' ? child.attrs.alt ?? '' : ''; });
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { id: slugger.slug(text.trim()) }));
  });
  return DecorationSet.create(doc, decorations);
}

export const headingAnchors = $prose(() => {
  const plugin: Plugin<DecorationSet> = new Plugin({
    state: {
      init: (_, state) => headingAnchorDecorations(state.doc),
      apply: (tr, previous) => tr.docChanged ? headingAnchorDecorations(tr.doc) : previous,
    },
    props: { decorations: state => plugin.getState(state) },
  });
  return plugin;
});
