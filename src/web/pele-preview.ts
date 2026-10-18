import type { RenderOptions } from "pele";
type ApplyPreview = (value: string | HTMLElement | null) => void;
let library: Promise<typeof import("pele")> | undefined;
let pele: typeof import("pele") | undefined;
let nextId = 0;
const previews = new Map<string, string>();
/**
 * Diagrams may grow past the text column on wide screens, up to MAX_WIDTH. Layout width is
 * quantized so small resizes keep the same geometry, and so the same comment regions.
 */
const STEP = 80, MIN_WIDTH = 320, MAX_WIDTH = 1200, GUTTER = 32, BLOCK_PADDING = 32;
let width = 0, observer: ResizeObserver | undefined, mutations: MutationObserver | undefined, observed: HTMLElement | undefined, frame = 0;

function columns(root: HTMLElement) {
  const style = getComputedStyle(root);
  const column = root.offsetWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const scene = root.parentElement?.offsetWidth ?? column;
  return { column, available: Math.max(column, Math.min(MAX_WIDTH, scene - 2 * GUTTER)) };
}
function measureWidth(root: HTMLElement): number {
  return Math.max(MIN_WIDTH, Math.floor((columns(root).available - BLOCK_PADDING - 8) / STEP) * STEP);
}
/** Widen a diagram's block to its drawing, centered on the text column. */
function fitBlocks() {
  frame = 0;
  if (!observed?.isConnected) return;
  const { column, available } = columns(observed);
  for (const block of observed.querySelectorAll<HTMLElement>(".milkdown-code-block")) {
    const svg = block.querySelector<SVGSVGElement>(".wm-pele svg");
    const wide = svg ? Math.min(available, svg.viewBox.baseVal.width + BLOCK_PADDING) : 0;
    if (wide > column + 1) {
      block.style.width = `${wide}px`;
      block.style.marginLeft = `${(column - wide) / 2}px`;
      block.classList.add("wm-wide-diagram");
    } else if (block.classList.contains("wm-wide-diagram")) {
      block.style.removeProperty("width");
      block.style.removeProperty("margin-left");
      block.classList.remove("wm-wide-diagram");
    }
  }
}
const scheduleFit = () => { frame ||= requestAnimationFrame(fitBlocks); };
/** Regions anchor to the viewBox, so only a width-bucket change re-renders diagrams. */
function watchWidth(root: HTMLElement) {
  if (observed === root) return;
  observer?.disconnect(); mutations?.disconnect();
  observed = root;
  width = measureWidth(root);
  observer = new ResizeObserver(() => {
    scheduleFit();
    const next = measureWidth(root);
    if (next === width) return;
    width = next;
    for (const block of root.querySelectorAll('.milkdown-code-block:has(.wm-pele)')) block.dispatchEvent(new Event('milkdown:refresh-preview'));
  });
  observer.observe(root);
  if (root.parentElement) observer.observe(root.parentElement);
  // Previews arrive after Crepe sanitizes them, and the viewer borrows the SVG while open.
  mutations = new MutationObserver(scheduleFit);
  mutations.observe(root, { childList: true, subtree: true });
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
  const root = document.querySelector<HTMLElement>("#editor .ProseMirror") ?? document.documentElement;
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
