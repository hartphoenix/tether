import type { AnnotationAnchor } from '../core/annotation-ledger';
import { captureVisual } from './visual-capture';

export async function visualMatches(source: SVGSVGElement | HTMLImageElement, anchor: AnnotationAnchor, currentSource?: string): Promise<boolean> {
    const saved = anchor.visual!;
    if (currentSource !== undefined && saved.source !== currentSource) return false;
    if (source instanceof SVGSVGElement) {
        const box = source.viewBox.baseVal;
        // Presentation styles and mounted SVG IDs are not changes to the diagram.
        return !!saved.viewBox && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(box[key] - saved.viewBox![key]) < .01);
    }
    if (saved.sourceRevision) {
        const response = await fetch(`api/visual-source?src=${encodeURIComponent(saved.source)}`);
        if (response.ok) {
            const result = await response.json();
            const revision = result.revision ?? result.data?.revision;
            if (revision) return revision === saved.sourceRevision;
        }
    }
    return (await captureVisual(source)).layoutRevision === saved.layoutRevision;
}

/** A source-sized layer: its boxes use source fractions, not viewport pixels. */
export function regionLayer(source: SVGSVGElement | HTMLImageElement, parent: HTMLElement, entries: { anchor: AnnotationAnchor; label: string; open: () => void }[]) {
    const layer = document.createElement('div');
    layer.className = 'wm-visual-regions';
    layer.contentEditable = 'false';
    for (const entry of entries) {
        const region = entry.anchor.visual!.region;
        const box = document.createElement('div');
        box.className = 'wm-visual-region';
        Object.assign(box.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` });
        const badge = document.createElement('button');
        badge.type = 'button'; badge.className = 'wm-visual-badge'; badge.textContent = entry.label;
        badge.setAttribute('aria-label', `${entry.label} messages in thread`);
        badge.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
        badge.onclick = event => { event.preventDefault(); event.stopPropagation(); entry.open(); };
        box.append(badge); layer.append(box);
    }
    parent.append(layer);
    const align = () => {
        const b = source.getBoundingClientRect(), p = parent.getBoundingClientRect();
        if (!b.width || !b.height) return;
        Object.assign(layer.style, { left: `${b.left - p.left + parent.scrollLeft}px`, top: `${b.top - p.top + parent.scrollTop}px`, width: `${b.width}px`, height: `${b.height}px` });
        const placed: DOMRect[] = [];
        for (const badge of layer.querySelectorAll<HTMLElement>('.wm-visual-badge')) {
            badge.style.transform = '';
            let rect = badge.getBoundingClientRect(), offset = 0;
            const step = rect.width + 3;
            while (offset > -entries.length * step && placed.some(other => rect.left < other.right + 3 && rect.right + 3 > other.left && rect.top < other.bottom + 3 && rect.bottom + 3 > other.top)) {
                offset -= step;
                badge.style.transform = `translateX(${offset}px)`;
                rect = badge.getBoundingClientRect();
            }
            placed.push(rect);
        }

    };
    const observer = new ResizeObserver(align); observer.observe(source); observer.observe(parent);
    layer.querySelectorAll('.wm-visual-badge').forEach(badge => observer.observe(badge));
    align();
    return { align, remove: () => { observer.disconnect(); layer.remove(); } };
}
