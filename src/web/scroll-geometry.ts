import type { EditorView } from '@milkdown/kit/prose/view';

type Rect = { left: number; right: number; top: number; bottom: number };

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
    if (vertical) node.scrollTop += delta(box.top, box.bottom, top + margin, top + node.clientHeight * sy - margin) / sy;
    const dx = (node.scrollLeft - beforeX) * sx;
    const dy = (node.scrollTop - beforeY) * sy;
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
