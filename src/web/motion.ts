/** Interruptible scrolling shared by review navigation and thread motion. */
export function smoothScroll(node: HTMLElement, top: number, left = node.scrollLeft): () => void {
  const win = node.ownerDocument.defaultView!;
  node.dispatchEvent(new Event('wm-stop-scroll'));
  const startTop = node.scrollTop, startLeft = node.scrollLeft, start = performance.now();
  let frame = 0;
  const stop = () => {
    win.cancelAnimationFrame(frame);
    for (const event of ['wheel', 'touchstart', 'wm-stop-scroll']) node.removeEventListener(event, stop);
  };
  for (const event of ['wheel', 'touchstart', 'wm-stop-scroll']) node.addEventListener(event, stop, { passive: true });
  const tick = () => {
    const t = win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, (performance.now() - start) / 200);
    const eased = 1 - Math.pow(1 - t, 3);
    node.scrollTo({ top: startTop + (top - startTop) * eased, left: startLeft + (left - startLeft) * eased, behavior: 'instant' });
    if (t < 1) frame = win.requestAnimationFrame(tick); else stop();
  };
  tick();
  return stop;
}

/** Self-contained so Folio can embed the same implementation. */
export function installMenuMotion(doc: Document): () => void {
  const win = doc.defaultView!;
  const selector = '.wm-theme-menu,.wm-zoom-menu,.wm-file-menu,.wm-comment-popover,.wm-thread-popover,.wm-tool-overflow-menu,.top-bar-heading-dropdown,.language-picker,.organization-panel,#row-menu,#app-menu';
  const visible = new WeakSet<Element>();
  const animations = new Map<Element, Animation>();
  const scan = () => {
    for (const [node, animation] of animations) if (!node.isConnected) { animation.cancel(); animations.delete(node); }
    for (const menu of doc.querySelectorAll<HTMLElement>(selector)) {
      if (!menu.getClientRects().length || menu.closest('[hidden]')) { visible.delete(menu); continue; }
      if (visible.has(menu)) continue;
      visible.add(menu);
      if (win.matchMedia('(prefers-reduced-motion: reduce)').matches || !menu.animate) continue;
      const trigger = menu.id === 'app-menu' ? doc.querySelector('#more') : menu.previousElementSibling ?? menu.parentElement;
      const box = menu.getBoundingClientRect(), origin = trigger?.getBoundingClientRect();
      menu.style.transformOrigin = menu.dataset.wmMenuOrigin ?? `${origin && origin.left > box.left + box.width / 2 ? 'right' : 'left'} ${origin && origin.top > box.top ? 'bottom' : 'top'}`;
      animations.get(menu)?.cancel();
      // Individual scale leaves a positioning transform intact.
      const animation = menu.animate([{ opacity: 0, scale: '.94 .85' }, { opacity: 1, scale: '1' }], { duration: 180, easing: 'ease-out' });
      animations.set(menu, animation);
      animation.onfinish = () => animations.delete(menu);
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-show', 'class'] });
  scan();
  return () => { observer.disconnect(); for (const animation of animations.values()) animation.cancel(); };
}
