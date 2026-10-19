import type { AnnotationAnchor } from '../core/annotation-ledger';
import { captureVisual } from './visual-capture';
import { VISUAL_LIMITS, type Region } from '../core/visual-anchor';

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
/** The box around every target still present in the current layout. */
export function targetsRegion(source: SVGSVGElement, targets: string[]): Region | null {
    const boxes = targets.map(t => targetRegion(source, t)).filter((r): r is Region => r !== null);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map(r => r.x)), y = Math.min(...boxes.map(r => r.y));
    return { x, y, width: Math.max(...boxes.map(r => r.x + r.width)) - x, height: Math.max(...boxes.map(r => r.y + r.height)) - y };
}
/** Elements whose boxes lie mostly inside a drawn region: what the reader meant to select. */
export function coveredTargets(source: SVGSVGElement, region: Region): string[] | undefined {
    const found: string[] = [];
    for (const element of source.querySelectorAll('[data-id]')) {
        const target = elementTarget(element), box = target ? elementRegion(source, element) : null;
        if (!target || !box) continue;
        const w = Math.max(0, Math.min(box.x + box.width, region.x + region.width) - Math.max(box.x, region.x));
        const h = Math.max(0, Math.min(box.y + box.height, region.y + region.height) - Math.max(box.y, region.y));
        if (w * h >= .75 * box.width * box.height && !found.includes(target)) found.push(target);
    }
    return found.length && found.length <= VISUAL_LIMITS.targets ? found : undefined;
}
/** Where a saved region belongs now: unchanged layouts keep it; targeted elements follow relayout. */
export function currentRegion(source: SVGSVGElement | HTMLImageElement, anchor: AnnotationAnchor): Region {
    const saved = anchor.visual!;
    if (!(source instanceof SVGSVGElement) || !saved.targets || sameLayout(source, saved)) return saved.region;
    const now = targetsRegion(source, saved.targets);
    if (!now || !saved.targetBox || !saved.viewBox) return now ?? saved.region;
    // Drawn regions keep their shape: same offset from their targets, scaled with the diagram.
    const before = saved.viewBox, after = source.viewBox.baseVal, scale = after.width / before.width;
    const center = (r: Region, w: number, h: number) => ({ x: (r.x + r.width / 2) * w, y: (r.y + r.height / 2) * h });
    const was = center(saved.targetBox, before.width, before.height), is = center(now, after.width, after.height), drawn = center(saved.region, before.width, before.height);
    const width = saved.region.width * before.width * scale, height = saved.region.height * before.height * scale;
    const x = is.x + (drawn.x - was.x) * scale - width / 2, y = is.y + (drawn.y - was.y) * scale - height / 2;
    // Also cover the targets wherever relayout put them (a row that became a column).
    const x0 = Math.max(0, Math.min(x / after.width, now.x)), y0 = Math.max(0, Math.min(y / after.height, now.y));
    const x1 = Math.min(1, Math.max((x + width) / after.width, now.x + now.width)), y1 = Math.min(1, Math.max((y + height) / after.height, now.y + now.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
export async function visualMatches(source: SVGSVGElement | HTMLImageElement, anchor: AnnotationAnchor, currentSource?: string): Promise<boolean> {
    const saved = anchor.visual!;
    if (currentSource !== undefined && saved.source !== currentSource) return false;
    if (source instanceof SVGSVGElement) return sameLayout(source, saved) || (!!saved.targets && targetsRegion(source, saved.targets) !== null);
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
        // Measure against the box that actually positions the layer: an inline image's parent is static.
        const host = (layer.offsetParent as HTMLElement | null) ?? parent;
        const b = source.getBoundingClientRect(), p = host.getBoundingClientRect();
        if (!b.width || !b.height) return;
        // Document zoom scales the host with a transform; convert screen pixels to its local pixels.
        const k = host.offsetWidth ? p.width / host.offsetWidth : 1;
        Object.assign(layer.style, { left: `${(b.left - p.left - host.clientLeft * k) / k + host.scrollLeft}px`, top: `${(b.top - p.top - host.clientTop * k) / k + host.scrollTop}px`, width: `${b.width / k}px`, height: `${b.height / k}px` });
        const placed: DOMRect[] = [];
        for (const badge of layer.querySelectorAll<HTMLElement>('.wm-visual-badge')) {
            badge.style.transform = '';
            let rect = badge.getBoundingClientRect(), offset = 0;
            const step = (rect.width + 3) / k;
            while (offset > -entries.length * step && placed.some(other => rect.left < other.right + 3 && rect.right + 3 > other.left && rect.top < other.bottom + 3 && rect.bottom + 3 > other.top)) {
                offset -= step;
                badge.style.transform = `translateX(${offset}px)`;
                rect = badge.getBoundingClientRect();
            }
            placed.push(rect);
        }

    };
    const observer = new ResizeObserver(align); observer.observe(source); observer.observe(parent);
    // A static parent (inline image) leaves the layer in an ancestor's coordinates; reflow there moves the image.
    if (layer.offsetParent && layer.offsetParent !== parent) observer.observe(layer.offsetParent);
    layer.querySelectorAll('.wm-visual-badge').forEach(badge => observer.observe(badge));
    align();
    return { align, remove: () => { observer.disconnect(); layer.remove(); } };
}
