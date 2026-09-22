import type { EditorView } from '@milkdown/kit/prose/view';

type Rect = { left: number; right: number; top: number; bottom: number };

/** Overlap a stationary sibling header without hiding the initial content. */
export function overlayScrollHeader(scroller: HTMLElement, header: HTMLElement): () => void {
  const measure = () => scroller.style.setProperty('--wm-scroll-header-height', `${header.offsetHeight}px`);
  const win = scroller.ownerDocument.defaultView!;
  const observer = win.ResizeObserver ? new win.ResizeObserver(measure) : null;
  observer?.observe(header);
  measure();
  return () => { observer?.disconnect(); scroller.style.removeProperty('--wm-scroll-header-height'); };
}

/** The glass-covered part of a lane is not usable reading space. */
export function scrollViewportTop(scroller: HTMLElement, top: number): number {
  const header = scroller.parentElement?.querySelector(':scope > .milkdown-top-bar, :scope > .wm-annotation-rail-header')
    ?? scroller.querySelector('.wm-annotation-rail-header');
  return Math.max(top, header?.getBoundingClientRect().bottom ?? top);
}

/** Recover only an empty viewport below content, leaving other lanes untouched. */
export function keepContentEndVisible(content: HTMLElement, scroller?: HTMLElement): () => void {
  const win = content.ownerDocument.defaultView!;
  let frame = 0;
  const check = () => {
    frame = 0;
    if (!content.isConnected || !content.getClientRects().length) return;
    // Container padding/min-height and hidden trailing Markdown are not content.
    let last = content.lastElementChild;
    while (last && !last.getBoundingClientRect().height) last = last.previousElementSibling;
    if (!last) return;
    const viewport = win.visualViewport;
    const bounds = scroller?.getBoundingClientRect();
    const scale = scroller ? (bounds!.height / scroller.offsetHeight || 1) : 1;
    let top = scroller ? bounds!.top + scroller.clientTop * scale
      : Math.max(viewport?.offsetTop ?? 0, content.closest('.milkdown')?.querySelector('.milkdown-top-bar')?.getBoundingClientRect().bottom ?? 0);
    const bottom = scroller ? top + scroller.clientHeight * scale
      : (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight);
    if (scroller) top = scrollViewportTop(scroller, top);
    const end = last.getBoundingClientRect().bottom;
    if (bottom <= top || end > top) return;
    // Put the end at 80% of the usable lane, with visible space beneath it.
    const delta = end - (top + (bottom - top) * .8);
    if (scroller) scroller.scrollTop += delta / scale;
    else win.scrollBy({ top: delta, behavior: 'instant' });
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(check);
  };
  const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  resize?.observe(content);
  if (scroller) resize?.observe(scroller);
  const mutations = new win.MutationObserver(schedule);
  mutations.observe(content, { childList: true, subtree: true, characterData: true, attributes: true });
  const target = scroller ?? win;
  target.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  schedule();
  return () => {
    win.cancelAnimationFrame(frame);
    resize?.disconnect();
    mutations.disconnect();
    target.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
  };
}

/** Scroll deltas enter in viewport pixels and leave in each scroller's local pixels. */
export function revealRect(rect: Rect, source: Element, margin = 8): void {
  const win = source.ownerDocument.defaultView!;
  const document = source.ownerDocument;
  let box = { ...rect };
  const delta = (start: number, end: number, min: number, max: number) =>
    start < min ? start - min : end > max ? Math.min(end - max, start - min) : 0;
  for (let node: Element | null = source; node && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = win.getComputedStyle(node);
    const horizontal = /auto|scroll|hidden/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    const vertical = /auto|scroll|hidden/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (!horizontal && !vertical) continue;
    const bounds = node.getBoundingClientRect();
    const sx = bounds.width / node.offsetWidth || 1;
    const sy = bounds.height / node.offsetHeight || 1;
    const left = bounds.left + node.clientLeft * sx;
    const top = bounds.top + node.clientTop * sy;
    const beforeX = node.scrollLeft, beforeY = node.scrollTop;
    if (horizontal) node.scrollLeft += delta(box.left, box.right, left + margin, left + node.clientWidth * sx - margin) / sx;
    if (vertical) node.scrollTop += delta(box.top, box.bottom, scrollViewportTop(node, top) + margin, top + node.clientHeight * sy - margin) / sy;
    const dx = (node.scrollLeft - beforeX) * sx;
    const dy = (node.scrollTop - beforeY) * sy;
    if (node.matches('.wm-document-scroll')) return;
    box = { left: box.left - dx, right: box.right - dx, top: box.top - dy, bottom: box.bottom - dy };
  }
  const toolbar = document.querySelector('.milkdown-top-bar')?.getBoundingClientRect();
  const viewport = win.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = Math.max(viewport?.offsetTop ?? 0, toolbar?.bottom ?? 0);
  win.scrollBy(delta(box.left, box.right, left + margin, left + (viewport?.width ?? win.innerWidth) - margin),
    delta(box.top, box.bottom, top + margin, (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight) - margin));
}

export function scrollSelectionIntoView(view: EditorView): boolean {
  const head = view.state.selection.head;
  const node = view.domAtPos(head).node;
  const source = node.nodeType === 1 ? node as Element : node.parentElement!;
  revealRect(view.coordsAtPos(head), source);
  return true;
}
