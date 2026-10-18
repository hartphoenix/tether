import type { AnnotationAnchor } from '../core/annotation-ledger';
import { captureVisual } from './visual-capture';
import type { Region } from '../core/visual-anchor';

function sameLayout(source: SVGSVGElement, saved: NonNullable<AnnotationAnchor['visual']>): boolean {
    const box = source.viewBox.baseVal;
    // Presentation styles and mounted SVG IDs are not changes to the diagram.
    return !!saved.viewBox && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(box[key] - saved.viewBox![key]) < .01);
}
/** An element's padded box as fractions of the diagram's viewBox. */
export function elementRegion(source: SVGSVGElement, element: Element): Region | null {
    const ctm = source.getScreenCTM(), b = source.viewBox.baseVal, r = element.getBoundingClientRect();
    if (!ctm || !r.width || !r.height) return null;
    const inverse = ctm.inverse(), pad = 4;
    const a = new DOMPoint(r.left, r.top).matrixTransform(inverse), c = new DOMPoint(r.right, r.bottom).matrixTransform(inverse);
    const x0 = Math.max(0, (a.x - pad - b.x) / b.width), y0 = Math.max(0, (a.y - pad - b.y) / b.height);
    const x1 = Math.min(1, (c.x + pad - b.x) / b.width), y1 = Math.min(1, (c.y + pad - b.y) / b.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
/** Pele elements carry their source identity; `class:id` names one across layouts. */
export function elementTarget(element: Element): string | undefined {
    const id = element.getAttribute('data-id'), kind = [...element.classList].find(name => name.startsWith('pele-'));
    return id && kind ? `${kind}:${id}` : undefined;
}
function targetRegion(source: SVGSVGElement, target: string): Region | null {
    const split = target.indexOf(':');
    const element = source.querySelector(`.${CSS.escape(target.slice(0, split))}[data-id="${CSS.escape(target.slice(split + 1))}"]`);
    return element ? elementRegion(source, element) : null;
}
/** Where a saved region belongs now: unchanged layouts keep it; snapped elements follow relayout. */
export function currentRegion(source: SVGSVGElement | HTMLImageElement, anchor: AnnotationAnchor): Region {
    const saved = anchor.visual!;
    if (!(source instanceof SVGSVGElement) || !saved.target || sameLayout(source, saved)) return saved.region;
    return targetRegion(source, saved.target) ?? saved.region;
}
export async function visualMatches(source: SVGSVGElement | HTMLImageElement, anchor: AnnotationAnchor, currentSource?: string): Promise<boolean> {
    const saved = anchor.visual!;
    if (currentSource !== undefined && saved.source !== currentSource) return false;
    if (source instanceof SVGSVGElement) return sameLayout(source, saved) || (!!saved.target && targetRegion(source, saved.target) !== null);
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
        const region = currentRegion(source, entry.anchor);
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
