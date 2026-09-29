/** Saved width is independent of the space available in this particular view. */
export function createRailResize(workspace: HTMLElement, rail: HTMLElement, persist: (width: number) => Promise<unknown>, onError: (error: unknown) => void) {
  let saved = 300;
  let displayed = 300;
  let dragging: { id: number; x: number; width: number } | undefined;
  const handle = document.createElement('div');
  handle.className = 'wm-rail-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', 'Threads width');
  handle.setAttribute('aria-orientation', 'vertical');
  const maximum = () => Math.max(228, Math.min(640, workspace.clientWidth - 320));
  const render = (width = saved) => {
    displayed = Math.max(228, Math.min(maximum(), width));
    workspace.style.setProperty('--wm-saved-rail-width', `${displayed}px`);
    handle.setAttribute('aria-valuemin', '228');
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(displayed)));
  };
  const commit = (width: number) => { saved = width; render(); void persist(saved).catch(onError); };
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.focus();
    dragging = { id: event.pointerId, x: event.clientX, width: displayed };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = event => { if (dragging?.id === event.pointerId) render(dragging.width + dragging.x - event.clientX); };
  handle.onpointerup = event => {
    if (dragging?.id !== event.pointerId) return;
    dragging = undefined; handle.releasePointerCapture(event.pointerId); commit(Math.round(displayed));
  };
  handle.onlostpointercapture = handle.onpointercancel = () => { dragging = undefined; render(); };
  handle.ondblclick = () => commit(300);
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); commit(Math.max(228, Math.min(maximum(), displayed + (event.key === 'ArrowLeft' ? 16 : -16))));
  };
  rail.append(handle);
  const observer = new ResizeObserver(() => render());
  observer.observe(workspace); render();
  return { update(width = 300) { saved = width; if (!dragging) render(); }, destroy() { observer.disconnect(); handle.remove(); } };
}
