import type { RenderOptions } from "pele";
type ApplyPreview = (value: string | HTMLElement | null) => void;
let library: Promise<typeof import("pele")> | undefined;
let pele: typeof import("pele") | undefined;
let nextId = 0;
const previews = new Map<string, string>();
/** Lay out for the column, quantized so small resizes keep the same layout. */
const STEP = 80, MIN_WIDTH = 320;
let width = 0, observer: ResizeObserver | undefined, observed: Element | undefined;

function measureWidth(root: Element): number {
  const style = getComputedStyle(root);
  const inner = root.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 40;
  return Math.max(MIN_WIDTH, Math.floor(inner / STEP) * STEP);
}
/** Regions anchor to the viewBox, so only a width-bucket change re-renders diagrams. */
function watchWidth(root: Element) {
  if (observed === root) return;
  observer?.disconnect();
  observed = root;
  width = measureWidth(root);
  observer = new ResizeObserver(() => {
    const next = measureWidth(root);
    if (next === width) return;
    width = next;
    for (const block of document.querySelectorAll('.milkdown-code-block:has(.wm-pele)')) block.dispatchEvent(new Event('milkdown:refresh-preview'));
  });
  observer.observe(root);
}

function themeOptions(): RenderOptions {
  const style = getComputedStyle(document.documentElement);
  const fontFamily = style.getPropertyValue("--pele-font").trim() || style.getPropertyValue("--wm-font-body").trim() || "sans-serif";
  const fontFamilyMono = style.getPropertyValue("--wm-font-code").trim() || "monospace";
  return { fontFamily, fontFamilyMono, fontSize: 15, maxWidth: width, links: false, images: false };
}

function instantiate(svg: string, type: string): string {
  // Pele emits IDs only for accessibility titles; prefix them per mount.
  const prefix = `tether-pele-${++nextId}`;
  return `<div class="wm-mermaid wm-pele" data-diagram="${type}">${svg.replace(/(id|aria-labelledby|aria-describedby)="pele-/g, `$1="${prefix}-`)}</div>`;
}

function renderNow(source: string): string {
  const options = themeOptions();
  const key = JSON.stringify([source, options]);
  let entry = previews.get(key);
  if (!entry) {
    const result = pele!.render(source, { ...options, idPrefix: "pele-" });
    entry = JSON.stringify([result.svg, result.type]);
    previews.set(key, entry);
    if (previews.size > 64) previews.delete(previews.keys().next().value!);
  }
  const [svg, type] = JSON.parse(entry) as [string, string];
  return instantiate(svg, type);
}

function failure(error: unknown): HTMLElement {
  const message = document.createElement("div");
  message.className = "wm-mermaid-error";
  message.textContent = `Diagram unavailable: ${(error as Error)?.message?.split("\n")[0] ?? "unknown error"}. Choose Edit to inspect the source.`;
  return message;
}

/** Pele renders synchronously once loaded; only the first diagram waits for the chunk. */
export function renderPelePreview(source: string, apply: ApplyPreview): string | HTMLElement | undefined {
  const root = document.querySelector("#editor .ProseMirror") ?? document.documentElement;
  watchWidth(root);
  if (pele) {
    try { return renderNow(source); } catch (error) { return failure(error); }
  }
  library ??= import("pele").catch(error => { library = undefined; throw error; });
  void library.then(async module => {
    pele = module;
    await document.fonts.ready;
    try { apply(renderNow(source)); } catch (error) { apply(failure(error)); }
  }, error => apply(failure(error)));
  return undefined;
}
