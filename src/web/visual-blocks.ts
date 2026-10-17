import type { Node } from '@milkdown/kit/prose/model';
import { renderedTextProjection, type AnnotationAnchor } from '../core/annotation-ledger';
import { locateVisualBlock, type VisualBlock } from '../core/visual-anchor';
export function editorVisualBlocks(doc: Node) {
    const projection = renderedTextProjection(doc);
    const blocks: Array<VisualBlock & {
        position: number;
    }> = [];
    doc.descendants((node, position) => {
        const image = node.type.name.includes('image'), mermaid = node.type.name === 'code_block' && String(node.attrs.language).toLowerCase() === 'mermaid';
        if (!image && !mermaid)
            return;
        const from = position + (image ? 0 : 1), to = position + node.nodeSize - (image ? 0 : 1);
        const segments = projection.segments.filter(s => s.kind !== 'separator' && s.from >= from && s.to <= to);
        if (!segments.length)
            return;
        blocks.push({ kind: image ? 'image' : 'mermaid', source: image ? String(node.attrs.src ?? '') : node.textContent, start: segments[0]!.projectionStart, end: segments.at(-1)!.projectionEnd, position });
    });
    return { projection, blocks };
}
const placements = new WeakMap<AnnotationAnchor, {
    doc: Node;
    position: number | null;
}>();
export function mapEditorVisualAnchor(anchor: AnnotationAnchor, previous: Node, next: Node, mapping: {
    mapResult: (position: number, assoc: number) => {
        pos: number;
        deleted: boolean;
    };
}) {
    const located = locateEditorVisual(previous, anchor);
    if (!located) {
        placements.set(anchor, { doc: next, position: null });
        return;
    }
    const result = mapping.mapResult(located.position, 1);
    placements.set(anchor, { doc: next, position: result.deleted ? null : result.pos });
}
export function locateEditorVisual(doc: Node, anchor: AnnotationAnchor, revision?: string) {
    const { projection, blocks } = editorVisualBlocks(doc);
    const remembered = placements.get(anchor);
    const block = remembered?.doc === doc ? blocks.find(b => b.position === remembered.position && b.kind === anchor.visual?.kind) : locateVisualBlock(anchor, projection.projection, blocks, revision);
    return block ? { ...block, position: blocks.find(b => b === block)!.position, from: projection.positionAt(block.start), to: projection.positionAt(block.end) } : null;
}
