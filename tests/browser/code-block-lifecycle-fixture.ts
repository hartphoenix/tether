import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { initialReaderSelection } from '../../src/web/initial-selection';
import { editorStateOptionsCtx } from '@milkdown/kit/core';
import { createCanvas } from '../../src/web/canvas';
import { renderMermaidPreview } from '../../src/web/mermaid-preview';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import '../../src/web/style.css';
import '../../src/web/canvas.css';

const params = new URLSearchParams(location.search);
const kind = params.get('kind') ?? 'mermaid';
const source = kind === 'code' ? 'const answer = 42;\n\n' : kind === 'error' ? 'not a diagram' : 'flowchart TD\n A[Start] --> B[Second] --> C[Third] --> D[Fourth] --> E[Finish]';
let cacheHits = 0;
let renders = 0;
const root = document.querySelector<HTMLElement>('#editor')!;
const crepe = new Crepe({
  root, defaultValue: '# Lifecycle\n\n```' + (kind === 'code' ? 'ts' : 'mermaid') + '\n' + source + '\n```\n\n' + Array.from({length:100}, (_, i) => `Paragraph ${i}. Stable reading content.`).join('\n\n'),
  features: { [Crepe.Feature.TopBar]: true, [Crepe.Feature.BlockEdit]: false },
  featureConfigs: { [Crepe.Feature.CodeMirror]: {
    previewOnlyByDefault: true, previewLoading: 'Rendering diagram…',
    renderPreview(language, text, apply) {
      const result = renderMermaidPreview(language, text, apply);
      if (typeof result === 'string') cacheHits++;
      else if (result === undefined) renders++;
      return result;
    },
  } },
});
crepe.editor.config(ctx => ctx.update(editorStateOptionsCtx, previous => options => initialReaderSelection(previous(options))));
await crepe.create();
const view = crepe.editor.action(ctx => ctx.get(editorViewCtx));
const canvas = createCanvas(view);
canvas.setScale(Number(params.get('scale') ?? 1), {preserveScroll:false});
(window as any).lifecycle = {
  stats: () => ({cacheHits, renders}),
  setSource(text: string, language = kind === 'code' ? 'ts' : 'mermaid') {
    let pos = -1;
    view.state.doc.forEach((node, offset) => { if (node.type.name === 'code_block') pos = offset; });
    const node = view.state.doc.nodeAt(pos)!;
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, node.type.create({...node.attrs, language}, text ? view.state.schema.text(text) : undefined)));
  },
  refresh() { root.querySelector('.milkdown-code-block')!.dispatchEvent(new Event('milkdown:refresh-preview')); },
  cachedCopies() { return [renderMermaidPreview('mermaid', source, () => {}), renderMermaidPreview('mermaid', source, () => {})]; },
};
