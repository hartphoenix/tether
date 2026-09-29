import { createRailResize } from '../../src/web/rail-resize';
import { Crepe } from '@milkdown/crepe';
import { editorStateOptionsCtx, editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createAnnotationUi, captureAnchor } from '../../src/web/annotations-ui';
import { createSelectionUi } from '../../src/web/selection-ui';
import { applyDesign } from '../../src/web/themes';
import { tetherDesign } from '../../src/shared/themes';
import { createCanvas } from '../../src/web/canvas';
import { scrollSelectionIntoView } from '../../src/web/scroll-geometry';
import { initialReaderSelection } from '../../src/web/initial-selection';
import '../../src/web/annotations-ui.css';
import '../../src/web/selection-ui.css';
import '../../src/web/chrome.css';
import '../../src/web/style.css';
import '../../src/web/canvas.css';
import '../../src/web/themes.css';
import '../../src/web/fonts.css';
import '../../src/web/thread-layout.css';

const root = document.querySelector<HTMLElement>('#editor')!;
applyDesign(root, 'tether', tetherDesign(false));
const paragraphs = Array.from({length: 40}, (_, i) => `Paragraph ${i}: Here is [target link ${i}](https://example.com/${i}) followed by ordinary words to form a paragraph.`);
const startup = new URL(location.href).searchParams.get('startup');
const banner = '![Geometry image](/image.svg)\n\n';
const markdown = startup === 'image-only' ? banner : (startup === 'long-prefix' ? banner.repeat(8) : '') + '# Geometry fixture\n\n' + paragraphs.map((text, i) => i === 20 ? banner + text : text).join('\n\n') + '\n\n```ts\nconst line = ' + '1234567890'.repeat(50) + ';\n```\n\n| One | Two |\n| --- | --- |\n| cell one | cell two |\n\nLast paragraph.';
let view: EditorView | null = null;
const annotations = createAnnotationUi({
  root: document.querySelector<HTMLElement>('#annotations')!, editorRoot: root, getEditorView: () => view,
  onCreateComment: ({body, anchor}) => annotations.setState({threads: [{id:'test-comment', actor:'human', createdAt:'2026-09-16T00:00:00Z', body, anchor}]}),
});
const selection = createSelectionUi({onNotice: message => console.info(message)});
const crepe = new Crepe({root, defaultValue: markdown, features: {[Crepe.Feature.TopBar]: true, [Crepe.Feature.BlockEdit]: false}, featureConfigs: {[Crepe.Feature.Placeholder]: {text: "..."}}});
crepe.editor.config(ctx => ctx.update(editorStateOptionsCtx, previous => options => initialReaderSelection(previous(options))));
crepe.editor.use(selection.plugin).use($prose(() => annotations.plugin));
await crepe.create();
view = crepe.editor.action(ctx => ctx.get(editorViewCtx));
const canvas = createCanvas(view);
canvas.setScale(Number(new URL(location.href).searchParams.get('scale') ?? 1), { preserveScroll: false });
view.setProps({handleScrollToSelection: scrollSelectionIntoView});
annotations.attachEditorView(view);
const railResize = createRailResize(document.querySelector('#workspace')!, document.querySelector('.wm-annotation-rail')!, async width => { (window as any).savedRailWidth = width; }, error => { throw error; });
(window as any).audit = {
  railResize,
  overflowThread() {
    const anchor = this.selectLink(0)!;
    annotations.setState({ threads: [{ id: 'overflow', actor: 'human', body: 'Question', createdAt: '2026-09-28T00:00:00Z', anchor,
      replies: [{ id: 'reply', actor: 'assistant', createdAt: '2026-09-28T00:01:00Z', body: '\x60\x60\x60\n' + 'x'.repeat(200) + '\n\x60\x60\x60\n\n| One | Two | Three | Four | Five | Six |\n| --- | --- | --- | --- | --- | --- |\n| wide | wide | wide | wide | wide | wide |' }] }] });
    annotations.setRailOpen(true); annotations.openThread('overflow');
  },
  crepe, view, annotations, selection, canvas,
  setZoom: (z: number) => canvas.setScale(z),
  selectLink(i: number) {
    const link = view!.dom.querySelectorAll('a')[i]!;
    const from = view!.posAtDOM(link, 0);
    view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, from, from + 5)));
    return captureAnchor(view!);
  },
  comment(i: number) { annotations.openCommentComposer(this.selectLink(i) ?? undefined); },
};
(window as any).ready = true;
