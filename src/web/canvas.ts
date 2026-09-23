import type { EditorView } from '@milkdown/kit/prose/view';
import { keepContentEndVisible, overlayScrollHeader } from './scroll-geometry';

/** The document alone scales; its shell, toolbar and free overlays stay in viewport pixels. */
export function createCanvas(view: EditorView, notice?: HTMLElement, updateButton?: HTMLElement) {
  const document = view.dom.ownerDocument;
  const win = document.defaultView!;
  const shell = view.dom.closest<HTMLElement>('.milkdown')!;
  const stage = document.createElement('div');
  stage.className = 'wm-canvas-stage';
  const scene = document.createElement('div');
  scene.className = 'wm-canvas-scene';
  const scroller = document.createElement('div');
  scroller.className = 'wm-document-scroll';
  view.dom.before(scroller);
  scroller.append(stage);
  stage.append(scene);
  scene.append(view.dom);
  const header = shell.querySelector<HTMLElement>('.milkdown-top-bar');
  if (updateButton && header) header.append(updateButton);
  if (notice) header ? header.after(notice) : scroller.before(notice);
  const stopHeaderOverlay = header ? overlayScrollHeader(scroller, header) : () => {};
  let scale = 1;
  let destroyed = false;
  let frame = 0;
  let followFrame = 0;
  const cancelFollow = () => { win.cancelAnimationFrame(followFrame); followFrame = 0; };
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) win.addEventListener(event, cancelFollow, { passive: true });

  const measure = () => {
    if (destroyed) return;
    const height = scene.getBoundingClientRect().height;
    const value = `${Math.ceil(height)}px`;
    if (stage.style.height !== value) stage.style.height = value;
  };
  const update = () => {
    if (frame || destroyed) return;
    frame = win.requestAnimationFrame(() => { frame = 0; measure(); });
  };
  const observer = new ResizeObserver(update);
  observer.observe(scene);
  win.addEventListener('resize', update);
  measure();

  const stopEndRecovery = keepContentEndVisible(view.dom, scroller);

  return {
    shell,
    stage,
    scroller,
    scene,
    get scale() { return scale; },
    setScale(next: number) {
      if (destroyed || !Number.isFinite(next)) return;
      next = Math.max(.75, Math.min(1.75, next));
      const toolbar = shell.querySelector('.milkdown-top-bar')?.getBoundingClientRect();
      const top = Math.max(toolbar?.bottom ?? 0, 0) + 24;
      // A DOM range remains measurable even when a floating control covers it.
      let anchor: Range | HTMLElement | undefined;
      let fallback: HTMLElement | undefined;
      for (const block of view.dom.children) {
        const box = block.getBoundingClientRect();
        if (box.bottom <= top || box.top >= win.innerHeight) continue;
        fallback ??= block as HTMLElement;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          const rect = range.getBoundingClientRect();
          if (rect.bottom <= top || rect.top >= win.innerHeight || !rect.height) continue;
          // Binary-search the first character on a visible line, not the node's
          // bounding box (which can start many screens above this passage).
          let low = 0, high = text.textContent.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            range.setStart(text, mid); range.setEnd(text, mid + 1);
            if (range.getBoundingClientRect().bottom <= top) low = mid + 1;
            else high = mid;
          }
          if (low === text.textContent.length) continue;
          range.setStart(text, low); range.setEnd(text, low + 1);
          anchor = range;
          break;
        }
        if (anchor) break;
      }
      anchor ??= fallback;
      const before = anchor?.getBoundingClientRect().top;
      scale = next;
      shell.style.setProperty('--wm-editor-scale', String(scale));
      measure();
      cancelFollow();
      if (before !== undefined && anchor) {
        // Node views (notably images and CodeMirror) finish reflow on later frames.
        // Preserve this reading anchor through that bounded settle, unless the user acts.
        let remaining = 8;
        const follow = () => {
          if (destroyed) return;
          const connected = anchor instanceof HTMLElement ? anchor.isConnected : anchor.startContainer.isConnected;
          if (!connected) return;
          measure();
          scroller.scrollTop += anchor.getBoundingClientRect().top - before;
          if (--remaining > 0) followFrame = win.requestAnimationFrame(follow);
          else followFrame = 0;
        };
        follow();
      }
      shell.dispatchEvent(new CustomEvent('wm-layout', { bubbles: true }));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      stopEndRecovery();
      stopHeaderOverlay();
      notice?.remove();
      updateButton?.remove();
      cancelFollow();
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) win.removeEventListener(event, cancelFollow);
      win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', update);
      scroller.before(view.dom);
      scroller.remove();
      shell.style.removeProperty('--wm-editor-scale');
    },
  };
}
