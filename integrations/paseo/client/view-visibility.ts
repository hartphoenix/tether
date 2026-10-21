/// <reference lib="dom" />
/** DOM-only seam for Paseo's retained panels; focus is deliberately irrelevant. */
export function observePaneVisibility(container: unknown, change: (visible: boolean) => void): () => void {
  const element = container as HTMLElement;
  if (!element?.ownerDocument || typeof element.getBoundingClientRect !== "function") return () => {};
  const doc = element.ownerDocument, win = doc.defaultView;
  if (!win) return () => {};
  let intersecting: boolean | undefined;
  let previous: boolean | undefined;
  const update = () => {
    const bounds = element.getBoundingClientRect();
    let visible = !doc.hidden && element.isConnected && bounds.width > 0 && bounds.height > 0 && intersecting !== false;
    for (let node: Element | null = element; visible && node; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") visible = false;
    }
    if (visible !== previous) { previous = visible; change(visible); }
  };
  const intersection = typeof win.IntersectionObserver === "undefined" ? undefined : new win.IntersectionObserver(entries => {
    const entry = entries[0];
    intersecting = entry ? entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0 : undefined;
    update();
  });
  const resize = typeof win.ResizeObserver === "undefined" ? undefined : new win.ResizeObserver(update);
  const mutation = new win.MutationObserver(update);
  for (let node: Element | null = element; node; node = node.parentElement) {
    mutation.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
  }
  intersection?.observe(element);
  resize?.observe(element);
  doc.addEventListener("visibilitychange", update);
  win.addEventListener("resize", update);
  update();
  return () => { intersection?.disconnect(); resize?.disconnect(); mutation.disconnect(); doc.removeEventListener("visibilitychange", update); win.removeEventListener("resize", update); };
}
