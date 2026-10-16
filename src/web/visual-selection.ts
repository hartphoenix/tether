import type { AnnotationThread, AnnotationUiController } from './annotations-ui';
import { iconSvg } from './icons';
import { regionLayer, visualMatches } from './visual-regions';
import { captureVisual } from './visual-capture';
import { validateRegion, type Region } from '../core/visual-anchor';
import type { AnnotationAnchor } from '../core/annotation-ledger';
export type VisualSelectionOptions = {
    createDrawer: (root: HTMLElement, onOpenChange: (open: boolean) => void) => AnnotationUiController;
    threads: () => readonly AnnotationThread[];
    prepare: () => Promise<AnnotationAnchor>;
    isCurrent?: () => boolean;
    save: (anchor: AnnotationAnchor, png: string, body: string, operationId: string) => Promise<void>;
    thread?: {
        id: string;
        body: string;
        anchor: AnnotationAnchor;
    };
    redraw?: boolean;
    startSelecting?: boolean;
    currentSource?: string;
    isThreadVisible?: () => boolean;
    regions?: () => {threadId: string; anchor: AnnotationAnchor; label: string; open: () => void}[];
};
/** The pointer loop only maps coordinates and paints an SVG rectangle. */
export function installVisualSelection(dialog: HTMLDialogElement, controls: HTMLElement, stage: HTMLElement, source: SVGSVGElement | HTMLImageElement, options: VisualSelectionOptions) {
    const threadPanel = document.createElement('div');
    threadPanel.className = 'wm-visual-drawer';
    dialog.append(threadPanel);
    const drawer = options.createDrawer(threadPanel, open => {
        dialog.classList.toggle('has-visual-threads', open);
    });
    const showThread = (id: string) => {
        drawer.setRailOpen(true);
        drawer.openThread(id);
    };
    const refreshThread = () => {
        const threads = options.threads();
        drawer.setState({threads: [...threads]});
        if (!threads.length) drawer.setRailOpen(false);
    };
    let regionDisplay: ReturnType<typeof regionLayer> | undefined;
    let regionGeneration = 0;
    const refreshRegions = async () => {
        const generation = ++regionGeneration;
        const entries = options.regions?.() ?? [];
        const matches = await Promise.all(entries.map(e => visualMatches(source, e.anchor, options.currentSource).catch(() => false)));
        if (generation !== regionGeneration) return;
        regionDisplay?.remove();
        regionDisplay = regionLayer(source, stage, entries.filter((_, i) => matches[i]).map(entry => ({...entry, open: () => showThread(entry.threadId)})));
    };
    void refreshRegions();
    document.addEventListener('wm-visual-threads', refreshRegions);
    refreshThread();
    if (options.thread) showThread(options.thread.id);
    dialog.addEventListener('wm-show-thread', () => { refreshThread(); if (options.thread) showThread(options.thread.id); });
    document.addEventListener('wm-visual-threads', refreshThread);
    const repaintThread = () => requestAnimationFrame(paint);
    document.addEventListener('wm-visual-threads', repaintThread);
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'wm-button wm-button-secondary wm-region-select';
    select.innerHTML = iconSvg('message-square') + 'Comment';
    select.setAttribute('aria-label', 'Comment');
    select.disabled = true;
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    status.className = 'wm-visual-status';
    status.textContent = 'Checking capture…';
    const actions = document.createElement('div');
    actions.className = 'wm-visual-actions';
    actions.append(select, status);
    controls.insertBefore(actions, controls.lastElementChild);
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.classList.add('wm-region-overlay');
    overlay.setAttribute('viewBox', '0 0 1 1');
    overlay.setAttribute('preserveAspectRatio', 'none');
    const rect = document.createElementNS(overlay.namespaceURI, 'rect');
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    overlay.append(rect);
    stage.append(overlay);
    let active = false, disposed = false, start: {
        x: number;
        y: number;
    } | null = null, pointer: number | null = null, region: Region | null = null, frame = 0, composer: HTMLElement | null = null, saving = false;
    let savedCurrent = false;
    let capture: Awaited<ReturnType<typeof captureVisual>> | undefined, anchor: AnnotationAnchor | undefined;
    function align() {
        const b = source.getBoundingClientRect(), s = stage.getBoundingClientRect();
        Object.assign(overlay.style, { left: `${b.left - s.left}px`, top: `${b.top - s.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    }
    function paint() {
        frame = 0;
        align();
        const bounds = overlay.getBoundingClientRect();
        const radius = active ? 0 : 4 * (Number(getComputedStyle(dialog).getPropertyValue('--wm-ui-scale')) || 1);
        rect.setAttribute('rx', String(bounds.width ? radius / bounds.width : 0));
        rect.setAttribute('ry', String(bounds.height ? radius / bounds.height : 0));
        const visible = options.isThreadVisible?.() !== false;
        rect.setAttribute('visibility', region && visible ? 'visible' : 'hidden');
        if (!visible) { status.textContent = ''; select.hidden = true; }
        if (region)
            for (const [k, v] of Object.entries(region))
                rect.setAttribute(k, String(v));
    }
    function setActive(value: boolean) {
        active = value;
        dialog.classList.toggle('is-selecting-region', value);
        select.classList.toggle('is-active', value);
        select.setAttribute('aria-pressed', String(value));
        overlay.style.pointerEvents = value ? 'auto' : 'none';
        overlay.style.cursor = value ? 'crosshair' : '';
        status.textContent = value ? 'select a region, or [esc] to cancel' : '';
        paint();
    }
    function cancel() {
        if (saving)
            return;
        start = null;
        if (pointer !== null && overlay.hasPointerCapture(pointer))
            overlay.releasePointerCapture(pointer);
        pointer = null;
        const saved = options.thread?.anchor.visual;
        region = null;
        composer?.remove();
        composer = null;
        setActive(false);
        if (saved)
            status.textContent = savedCurrent ? 'Selected region' : 'Region from an earlier version';
        paint();
    }
    async function begin() {
        if (active || composer) {
            cancel();
            return;
        }
        select.disabled = true;
        try {
            if (options.isCurrent?.() === false) throw new Error("The visual changed. Reopen it and select again.");
        anchor = await options.prepare();
            await Promise.all(dialog.getAnimations().map(animation => animation.finished.catch(() => {})));
            capture = await captureVisual(source);
            if (disposed)
                return;
            setActive(true);
        }
        catch (e) {
            status.textContent = (e as Error).message;
        }
        finally {
            select.disabled = false;
        }
    }
    const point = (event: PointerEvent) => {
        if (source instanceof SVGSVGElement) {
            const ctm = source.getScreenCTM();
            if (!ctm)
                throw Error('Diagram transform unavailable.');
            const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse()), b = source.viewBox.baseVal;
            return { x: Math.max(0, Math.min(1, (p.x - b.x) / b.width)), y: Math.max(0, Math.min(1, (p.y - b.y) / b.height)) };
        }
        const b = source.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (event.clientX - b.left) / b.width)), y: Math.max(0, Math.min(1, (event.clientY - b.top) / b.height)) };
    };
    function move(e: PointerEvent) {
        if (!start || e.pointerId !== pointer)
            return;
        const p = point(e);
        region = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(start.x - p.x), height: Math.abs(start.y - p.y) };
        if (!frame)
            frame = requestAnimationFrame(paint);
    }
    async function submit(body: string, operationId: string) {
        if (!region || !capture || !anchor)
            return;
        if (options.isCurrent?.() === false) throw new Error("The visual changed. Reopen it and select again.");
        const latest = await captureVisual(source);
        if (latest.layoutRevision !== capture.layoutRevision)
            throw Error('The visual changed. Cancel and select a new region.');
        const nextAnchor = { ...anchor, visual: { ...anchor.visual!, width: capture.width, height: capture.height, evidence: capture.evidence, layoutRevision: capture.layoutRevision, ...(capture.viewBox ? { viewBox: capture.viewBox } : {}), region: validateRegion(region) } };
        await options.save(nextAnchor, capture.png, body, operationId);
        if (options.thread) {
            options.thread = { ...options.thread, anchor: nextAnchor };
            savedCurrent = true;
            select.hidden = true;
        }
    }
    function compose() {
        const form = document.createElement('form');
        form.className = 'wm-comment-popover wm-annotation-form wm-region-composer';
        composer = form;
        const text = document.createElement('textarea');
        text.className = 'wm-annotation-textarea';
        text.rows = 3;
        text.setAttribute('aria-label', options.thread ? 'Replacement region' : 'Comment');
        text.placeholder = 'Comment on this region';
        text.required = !options.thread;
        const error = document.createElement('div');
        error.setAttribute('role', 'status');
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = options.thread ? 'Save selection' : 'Comment';
        save.className = 'wm-button wm-button-primary';
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'wm-button wm-button-secondary';
        discard.textContent = 'Cancel';
        discard.onclick = cancel;
        const actions = document.createElement('div');
        actions.className = 'wm-annotation-actions';
        actions.append(discard, save);
        if (!options.thread)
            form.append(text);
        form.append(error, actions);
        dialog.append(form);
        const operationId = crypto.randomUUID();
        form.onsubmit = async (e) => {
            e.preventDefault();
            saving = true;
            save.disabled = discard.disabled = true;
            try {
                await submit(text.value.trim(), operationId);
                saving = false;
                cancel();
                paint();
                status.textContent = 'Saved';
            }
            catch (e) {
                error.textContent = (e as Error).message;
            }
            finally {
                saving = false;
                save.disabled = discard.disabled = false;
            }
        };
        if (options.thread)
            form.requestSubmit();
        else
            text.focus();
    }
    overlay.addEventListener('pointerdown', e => {
        if (!active || saving || e.button !== 0)
            return;
        e.preventDefault();
        start = point(e);
        pointer = e.pointerId;
        overlay.setPointerCapture(pointer);
        region = null;
    });
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', e => {
        if (!start || e.pointerId !== pointer)
            return;
        move(e);
        start = null;
        overlay.releasePointerCapture(e.pointerId);
        pointer = null;
        paint();
        if (!region || region.width <= 0 || region.height <= 0) {
            region = null;
            paint();
            return;
        }
        setActive(false);
        compose();
    });
    overlay.addEventListener('pointercancel', () => {
        start = null;
        region = null;
        pointer = null;
        paint();
    });
    select.onclick = () => void begin();
    dialog.addEventListener("wm-redraw", () => void begin());
    dialog.addEventListener('cancel', e => {
        if (active || composer || saving) {
            e.preventDefault();
            cancel();
        }
    });
    const cancelGesture = () => {
        requestAnimationFrame(() => { paint(); regionDisplay?.align(); });
        if (start) {
            start = null;
            region = null;
            if (pointer !== null && overlay.hasPointerCapture(pointer))
                overlay.releasePointerCapture(pointer);
            pointer = null;
            paint();
        }
    };
    dialog.addEventListener('wm-visual-transform', cancelGesture);
    const resize = new ResizeObserver(() => {
        cancelGesture();
        paint();
    });
    resize.observe(source);
    void captureVisual(source).then(async c => {
        if (disposed)
            return;
        capture = c;
        select.disabled = false;
        status.textContent = '';
        const saved = options.thread?.anchor.visual;
        if (saved) {
            const current = await visualMatches(source, options.thread!.anchor, options.currentSource);
            if (disposed) return;
            savedCurrent = current;
            status.textContent = current ? 'Selected region' : 'Region from an earlier version';
            if (current) {
                paint();
            }
            select.hidden = current;
            select.textContent = 'Redraw selection';
            select.setAttribute('aria-label', 'Redraw selection');
        }
        if (options.startSelecting || (options.redraw && !savedCurrent))
            void begin();
    }).catch(e => {
        status.textContent = (e as Error).message;
    });
    return () => {
        disposed = true;
        drawer.destroy();
        threadPanel.remove();
        regionGeneration++;
        regionDisplay?.remove();
        document.removeEventListener('wm-visual-threads', refreshRegions);
        document.removeEventListener('wm-visual-threads', refreshThread);
        document.removeEventListener('wm-visual-threads', repaintThread);
        resize.disconnect();
        cancelAnimationFrame(frame);
    };
}
export function historicalVisual(anchor: AnnotationAnchor, url: string): HTMLElement {
    const holder = document.createElement('div');
    holder.className = 'wm-historical-visual';
    const image = document.createElement('img');
    image.src = url;
    image.alt = 'Saved visual selection';
    image.style.width = '100%';
    image.style.display = 'block';
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('viewBox', '0 0 1 1');
    overlay.setAttribute('preserveAspectRatio', 'none');
    const rectangle = document.createElementNS(overlay.namespaceURI, 'rect');
    for (const [key, value] of Object.entries(anchor.visual!.region))
        rectangle.setAttribute(key, String(value));
    rectangle.setAttribute('vector-effect', 'non-scaling-stroke');
    overlay.append(rectangle);
    holder.append(image, overlay);
    return holder;
}
