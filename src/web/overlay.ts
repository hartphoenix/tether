export type ViewportRect = { left: number; right: number; top: number; bottom: number };
export type OverlayPolicy = 'follow' | 'pin' | 'dismiss';

import { watchGeometry } from '@milkdown/kit/plugin/tooltip';

export function canvasBounds(root?: HTMLElement): ViewportRect {
  const document = root?.ownerDocument ?? window.document;
  const win = document.defaultView!;
  const viewport = win.visualViewport;
  const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
  const canvas = root?.getBoundingClientRect();
  const toolbar = document.querySelector('.milkdown-top-bar')?.getBoundingClientRect();
  const left = Math.max(x, canvas?.width ? canvas.left : x) + 8;
  const right = Math.min(x + (viewport?.width ?? win.innerWidth), canvas?.width ? canvas.right : Infinity) - 8;
  const top = Math.max(y, toolbar?.bottom ?? y) + 8;
  return { left, right: Math.max(left + 1, right), top, bottom: Math.max(top + 1, y + (viewport?.height ?? win.innerHeight) - 8) };
}

export function overlayPosition(reference: ViewportRect | null, width: number, height: number, bounds: ViewportRect, above = false) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  let top = reference ? (above ? reference.top - height - 8 : reference.bottom + 8) : bounds.top;
  if (reference && top + height > bounds.bottom) top = reference.top - height - 8;
  if (reference && top < bounds.top && reference.bottom + height + 8 <= bounds.bottom) top = reference.bottom + 8;
  return { left: clamp(reference?.left ?? bounds.left, bounds.left, bounds.right - width), top: clamp(top, bounds.top, bounds.bottom - height) };
}

/** Fixed, unscaled UI. Keep semantic references live; never retain an old DOMRect. */
export function placeOverlay(node: HTMLElement, options: {
  reference: () => ViewportRect | null;
  root?: HTMLElement;
  policy?: OverlayPolicy;
  above?: boolean;
  close?: () => void;
}): () => void {
  const win = node.ownerDocument.defaultView!;
  const policy = options.policy ?? 'pin';
  let disposed = false;
  let last = '';
  let stop = () => {};
  const dispose = () => { disposed = true; stop(); win.removeEventListener('scroll', close, true); win.removeEventListener('resize', close); node.ownerDocument.removeEventListener('wm-layout', close); };
  const close = () => { dispose(); options.close ? options.close() : node.remove(); };
  const update = () => {
    if (disposed) return;
    if (!node.isConnected) { dispose(); return; }
    let reference: ViewportRect | null = null;
    try { reference = options.reference(); } catch {}
    const bounds = canvasBounds(options.root);
    const visible = reference && reference.bottom >= bounds.top && reference.top <= bounds.bottom && reference.right >= bounds.left && reference.left <= bounds.right;
    if (!visible && policy === 'follow') { close(); return; }
    const maxWidth = bounds.right - bounds.left, maxHeight = bounds.bottom - bounds.top;
    node.style.maxWidth = `${maxWidth}px`;
    node.style.maxHeight = `${maxHeight}px`;
    const position = overlayPosition(visible ? reference : null, node.offsetWidth, node.offsetHeight, bounds, options.above);
    const key = `${position.left}:${position.top}`;
    if (key !== last) {
      node.style.left = `${position.left}px`; node.style.top = `${position.top}px`; last = key;
    }
  };
  node.style.position = 'fixed';
  node.style.overflow = 'auto';
  if (policy === 'dismiss') {
    win.addEventListener('scroll', close, true); win.addEventListener('resize', close); node.ownerDocument.addEventListener('wm-layout', close);
  }
  stop = watchGeometry(win, update);
  update();
  return dispose;
}
