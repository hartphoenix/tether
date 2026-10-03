import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { diffPluginKey, getPendingChanges } from '@milkdown/kit/plugin/diff';
import { configureMarkdownSerialization } from '../../src/web/markdown-serialization';
import { configureFootnotes, footnoteOrdering } from '../../src/web/footnotes';
import { incomingDiffPlugins, startIncomingDiff, acceptIncomingDiff } from '../../src/web/incoming-diff';
import { headingAnchors } from '../../src/web/heading-anchors';

const crepe = new Crepe({ root: '#editor', defaultValue: 'Ready.', features: { [Crepe.Feature.BlockEdit]: false } });
crepe.editor.config(configureMarkdownSerialization).config(configureFootnotes).use(footnoteOrdering).use(incomingDiffPlugins).use(headingAnchors);
await crepe.create();
const view = crepe.editor.ctx.get(editorViewCtx);
(window as any).regressions = {
  destroy: () => crepe.destroy(),
  anchors(source: string) {
    const doc = crepe.editor.ctx.get(parserCtx)(source)!;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    return Array.from(view.dom.querySelectorAll('h1,h2,h3,h4,h5,h6'), heading => heading.id);
  },
  roundTrip(source: string) {
    const parser = crepe.editor.ctx.get(parserCtx);
    const doc = parser(source)!;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    const markdown = crepe.getMarkdown();
    const reparsed = parser(markdown)!;
    let math = 0;
    reparsed.descendants(node => { if (node.type.name === 'math_inline') math++; });
    return { markdown, math, text: reparsed.textContent };
  },
  diff(before: string, after: string) {
    const doc = crepe.editor.ctx.get(parserCtx)(before)!;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    startIncomingDiff(crepe.editor, after);
    const diff = diffPluginKey.getState(view.state)!;
    const changes = getPendingChanges(diff).map(change => ({
      removed: view.state.doc.textBetween(change.fromA, change.toA),
      added: diff.newDoc.textBetween(change.fromB, change.toB),
    }));
    acceptIncomingDiff(crepe.editor);
    return changes;
  },
};
