/**
 * Hovering or tapping a Pele element traces what it touches: elements sharing its data-id
 * (a slice and its legend entry) and, for nodes, incident edges and their far ends.
 * Only the outermost unrelated items dim, so nested items (timeline events inside a period)
 * never fade twice and a container stays lit around its traced child.
 * Styling lives under `.wm-trace`, which visual capture removes before measuring.
 */
const NODES = ".pele-node, .pele-sankey-node, .pele-commit, .pele-lifeline";
const EDGES = ".pele-edge, .pele-sankey-link";
const ITEMS = `${NODES}, ${EDGES}, .pele-edge-label, .pele-slice, .pele-legend-item, .pele-task, .pele-point, .pele-cluster`;
const TOLERANCE = 10, CLEAR_DELAY = 120;
const MARKS = ["is-traced", "is-neighbor", "is-dimmed"];

type Box = { left: number; top: number; right: number; bottom: number };
const near = (p: DOMPoint, b: Box) => p.x >= b.left - TOLERANCE && p.x <= b.right + TOLERANCE && p.y >= b.top - TOLERANCE && p.y <= b.bottom + TOLERANCE;

function endpoints(edge: Element): DOMPoint[] {
  const points: DOMPoint[] = [];
  const paths = edge.matches("path, line, polyline") ? [edge as SVGGeometryElement] : edge.querySelectorAll<SVGGeometryElement>("path:not(.pele-marker), line, polyline");
  for (const path of paths) {
    const ctm = path.getScreenCTM();
    if (!ctm) continue;
    const length = path.getTotalLength();
    if (!length) continue;
    points.push(path.getPointAtLength(0).matrixTransform(ctm), path.getPointAtLength(length).matrixTransform(ctm));
  }
  return points;
}

function clear(svg: SVGSVGElement) {
  svg.classList.remove("wm-trace");
  for (const el of svg.querySelectorAll(".is-traced, .is-neighbor, .is-dimmed")) el.classList.remove(...MARKS);
}

function trace(svg: SVGSVGElement, item: Element) {
  // Classes change in one task, so CSS transitions run from the current state to the next.
  for (const el of svg.querySelectorAll(".is-traced, .is-neighbor, .is-dimmed")) el.classList.remove(...MARKS);
  const id = item.getAttribute("data-id");
  const same = id ? [...svg.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)] : [item];
  for (const el of same) el.classList.add("is-traced");
  const nodes = [...svg.querySelectorAll(NODES)], edges = [...svg.querySelectorAll(EDGES)];
  const boxes = new Map(nodes.map(node => [node, node.getBoundingClientRect() as Box]));
  const touching = (edge: Element) => { const ends = endpoints(edge); return nodes.filter(n => ends.some(p => near(p, boxes.get(n)!))); };
  if (item.matches(NODES)) {
    for (const edge of edges) {
      const ends = touching(edge);
      if (!ends.includes(item)) continue;
      edge.classList.add("is-traced");
      const label = edge.getAttribute("data-id");
      if (label) for (const el of svg.querySelectorAll(`.pele-edge-label[data-id="${CSS.escape(label)}"]`)) el.classList.add("is-traced");
      for (const node of ends) if (node !== item) node.classList.add("is-neighbor");
    }
  } else if (item.matches(`${EDGES}, .pele-edge-label`)) {
    for (const edge of same.filter(el => el.matches(EDGES))) for (const node of touching(edge)) node.classList.add("is-neighbor");
  }
  const lit = ".is-traced, .is-neighbor";
  for (const el of svg.querySelectorAll(ITEMS)) {
    if (el.matches(lit) || el.querySelector(lit) || el.parentElement?.closest(`.is-dimmed, ${lit}`)) continue;
    el.classList.add("is-dimmed");
  }
  svg.classList.add("wm-trace");
}

export function installDiagramTrace(root: Document = document) {
  let current: SVGSVGElement | null = null, pending = 0;
  root.addEventListener("pointerover", event => {
    clearTimeout(pending);
    const target = event.target instanceof Element ? event.target : null;
    const svg = target?.closest<SVGSVGElement>("svg.pele");
    if (current && current !== svg) { clear(current); current = null; }
    // Never alter styles while a region is being chosen or composed: capture compares them.
    if (!svg || svg.closest(".is-selecting-region") || document.querySelector(".wm-region-composer")) return;
    const item = target!.closest(ITEMS);
    current = svg;
    // Crossing the gap between two items keeps the trace instead of flashing back to full.
    if (item && svg.contains(item)) trace(svg, item); else pending = window.setTimeout(() => clear(svg), CLEAR_DELAY);
  });
  root.documentElement.addEventListener("pointerleave", () => { if (current) clear(current); current = null; });
}
