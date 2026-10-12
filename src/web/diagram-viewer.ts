import { iconSvg } from "./icons";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

const expandIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m0-6 7 7m5-7h6v6m0-6-7 7M3 15v6h6m-6 0 7-7m11 1v6h-6m6 0-7-7" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';

const documentImage = "img.image-inline, .milkdown-image-block .image-wrapper > img";

/** Diagrams move into the viewer to keep their SVG IDs unique; images are copied. */
export function openDiagramViewer(source: SVGSVGElement | HTMLImageElement, trigger: HTMLElement): () => void {
  const image = source instanceof HTMLImageElement;
  const svg = image ? source.cloneNode() as HTMLImageElement : source;
  if (image) svg.removeAttribute("style");
  const parent = source.parentElement!;
  const originalStyle = svg.getAttribute("style");
  const dialog = document.createElement("dialog");
  dialog.className = "wm-diagram-viewer";
  dialog.setAttribute("aria-label", image ? "Image viewer" : "Diagram viewer");
  const controls = document.createElement("div");
  controls.className = "wm-diagram-controls";
  const viewport = document.createElement("div");
  viewport.className = "wm-diagram-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", `${image ? "Image" : "Diagram"}; pinch to zoom, scroll to pan`);
  const stage = document.createElement("div");
  stage.className = "wm-diagram-stage";
  const output = document.createElement("output");
  output.setAttribute("aria-label", image ? "Image zoom" : "Diagram zoom");
  const box = image ? { width: source.naturalWidth, height: source.naturalHeight } : source.viewBox.baseVal;
  const width = box.width || source.getBoundingClientRect().width || 1;
  const height = box.height || source.getBoundingClientRect().height || 1;
  let zoom = 1, fit = 1, closed = false;
  function layout() {
    const w = width * fit * zoom, h = height * fit * zoom;
    stage.style.width = `${Math.max(viewport.clientWidth, w + 32)}px`;
    stage.style.height = `${Math.max(viewport.clientHeight, h + 32)}px`;
    svg.style.setProperty("width", `${w}px`, "important");
    svg.style.setProperty("height", `${h}px`, "important");
    svg.style.setProperty("max-width", "none", "important");
    output.textContent = `${Math.round(zoom * 100)}%`;
  }
  function setZoom(value: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    const oldWidth = width * fit * zoom, oldHeight = height * fit * zoom;
    const px = (viewport.scrollLeft + x - (stage.clientWidth - oldWidth) / 2) / oldWidth;
    const py = (viewport.scrollTop + y - (stage.clientHeight - oldHeight) / 2) / oldHeight;
    zoom = Math.max(.2, Math.min(8, value));
    layout();
    viewport.scrollLeft = px * width * fit * zoom + (stage.clientWidth - width * fit * zoom) / 2 - x;
    viewport.scrollTop = py * height * fit * zoom + (stage.clientHeight - height * fit * zoom) / 2 - y;
  }
  function button(label: string, icon: Parameters<typeof iconSvg>[0], action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-comment-button";
    button.innerHTML = iconSvg(icon);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", action);
    controls.append(button);
    return button;
  }
  button("Zoom out", "zoom-out", () => setZoom(zoom / 1.25));
  controls.append(output);
  button("Zoom in", "zoom-in", () => setZoom(zoom * 1.25));
  button("Fit", "minimize", () => { zoom = 1; resize(); });
  const close = button("Close", "x", () => dialog.close());
  stage.append(svg); viewport.append(stage); dialog.append(controls, viewport); document.body.append(dialog);
  function resize() {
    fit = Math.max(.01, Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    layout();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  let gestureZoom = 1, gesturing = false;
  viewport.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (gesturing) return;
    const rect = viewport.getBoundingClientRect();
    setZoom(zoom * Math.exp(-event.deltaY * .01), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener("gesturestart", event => { event.preventDefault(); gestureZoom = zoom; gesturing = true; }, { passive: false });
  viewport.addEventListener("gesturechange", event => {
    event.preventDefault();
    setZoom(gestureZoom * (event as Event & { scale: number }).scale);
  }, { passive: false });
  viewport.addEventListener("gestureend", event => { event.preventDefault(); gesturing = false; }, { passive: false });
  function dispose() {
    if (closed) return;
    closed = true; observer.disconnect();
    if (!image) {
      if (originalStyle === null) svg.removeAttribute("style"); else svg.setAttribute("style", originalStyle);
      if (parent.isConnected) parent.append(svg);
    }
    dialog.remove();
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  dialog.addEventListener("close", dispose);
  dialog.showModal(); resize(); close.focus({ preventScroll: true });
  return dispose;
}

/** Add controls only after Crepe has installed its sanitized preview. */
export const diagramViewer = $prose(() => new Plugin({
  view: view => {
    let close: (() => void) | undefined;
    let activePreview: HTMLElement | null = null;
    const controls = new Map<HTMLElement, () => void>();
    const sync = () => {
      if (activePreview && !activePreview.isConnected) { close?.(); close = undefined; activePreview = null; }
      for (const [block, dispose] of controls) if (!view.dom.contains(block) || !block.querySelector(".wm-mermaid")) { dispose(); controls.delete(block); }
      for (const block of view.dom.querySelectorAll<HTMLElement>(".milkdown-code-block")) {
        if (controls.has(block) || !block.querySelector(".wm-mermaid svg")) continue;
        const tools = block.querySelector(".tools-button-group");
        if (!tools) continue;
        const button = document.createElement("button");
        button.type = "button"; button.className = "wm-diagram-expand";
        button.innerHTML = expandIcon + "Zoom";
        button.setAttribute("aria-label", "Expand diagram");
        const expand = () => {
          const svg = block.querySelector<SVGSVGElement>(".wm-mermaid svg");
          if (svg) { close?.(); activePreview = svg.parentElement; close = openDiagramViewer(svg, button); }
        };
        button.addEventListener("click", expand);
        const pinch = (event: Event) => {
          if (event instanceof WheelEvent && !event.ctrlKey) return;
          const svg = block.querySelector<SVGSVGElement>(".wm-mermaid svg");
          if (!svg?.getClientRects().length) return;
          event.preventDefault();
          expand();
        };
        block.addEventListener("wheel", pinch, { passive: false });
        block.addEventListener("gesturestart", pinch, { passive: false });
        tools.append(button);
        controls.set(block, () => {
          block.removeEventListener("wheel", pinch);
          block.removeEventListener("gesturestart", pinch);
          button.remove();
        });
      }
    };
    const openImage = (event: Event) => {
      if (event instanceof WheelEvent && !event.ctrlKey) return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !target.matches(documentImage) || !target.naturalWidth) return;
      event.preventDefault();
      close?.(); activePreview = target; close = openDiagramViewer(target, view.dom);
    };
    view.dom.addEventListener("click", openImage);
    view.dom.addEventListener("wheel", openImage, { passive: false });
    view.dom.addEventListener("gesturestart", openImage, { passive: false });
    const observer = new MutationObserver(sync);
    observer.observe(view.dom, { childList: true, subtree: true }); sync();
    return { destroy: () => {
      observer.disconnect(); close?.(); for (const dispose of controls.values()) dispose();
      view.dom.removeEventListener("click", openImage);
      view.dom.removeEventListener("wheel", openImage);
      view.dom.removeEventListener("gesturestart", openImage);
    } };
  },
}));
