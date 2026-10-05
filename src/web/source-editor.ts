import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const markdownColors = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.escape, tags.character, tags.atom], color: 'var(--wm-color-primary)' },
  { tag: [tags.url, tags.labelName], color: 'var(--wm-color-primary)' },
  { tag: tags.comment, color: 'var(--wm-color-on-surface-variant)' },
]);

export function createSourceEditor(body: string, readOnly: boolean, onChange: () => void) {
  const access = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: body,
      extensions: [
        // Keep literal CR characters, including mixed line endings, in the source.
        EditorState.lineSeparator.of('\n'),
        EditorState.tabSize.of(4),
        access.of(EditorState.readOnly.of(readOnly)),
        EditorView.editorAttributes.of({ class: 'wm-source-editor' }),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'false' }),
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
        syntaxHighlighting(markdownColors),
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(); }),
      ],
    }),
  });
  return {
    dom: view.dom,
    scroller: view.scrollDOM,
    get value() { return view.state.sliceDoc(); },
    setReadOnly(value: boolean) { view.dispatch({ effects: access.reconfigure(EditorState.readOnly.of(value)) }); },
    replaceBody(body: string) {
      const previous = view.state.sliceDoc();
      let from = 0, to = previous.length, end = body.length;
      while (from < to && from < end && previous[from] === body[from]) from++;
      while (to > from && end > from && previous[to - 1] === body[end - 1]) { to--; end--; }
      view.dispatch({ changes: { from, to, insert: body.slice(from, end) } });
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); view.dom.remove(); },
  };
}
