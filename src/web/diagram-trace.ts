/**
 * Hovering or tapping a Pele element traces what it touches: elements sharing its data-id
 * (a slice and its legend entry) and, for nodes, incident edges and their far ends.
 * Styling lives under `.wm-trace`, which visual capture removes before measuring.
 */
const NODES = ".pele-node, .pele-sankey-node, .pele-commit, .pele-lifeline";
const EDGES = ".pele-edge, .pele-sankey-link";
const ITEMS = `${NODES}, ${EDGES}, .pele-edge-label, .pele-slice, .pele-legend-item, .pele-task, .pele-point, .pele-cluster`;
const TOLERANCE = 10;

type Box = { left: number; top: number; right: number; bottom: number };
const near = (p: DOMPoint, b: Box) => p.x >= b.left - TOLERANCE && p.x <= b.right + TOLERANCE && p.y >= b.top - TOLERANCE && p.y <= b.bottom + TOLERANCE;

function endpoints(edge: Element): DOMPoint[] {
  const points: DOMPoint[] = [];
  for (const path of edge.querySelectorAll<SVGGeometryElement>("path:not(.pele-marker), line, polyline")) {
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
  for (const el of svg.querySelectorAll(".is-traced, .is-neighbor")) el.classList.remove("is-traced", "is-neighbor");
}

function trace(svg: SVGSVGElement, item: Element) {
  clear(svg);
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
  svg.classList.add("wm-trace");
}

export function installDiagramTrace(root: Document = document) {
  let current: SVGSVGElement | null = null;
  root.addEventListener("pointerover", event => {
    const target = event.target instanceof Element ? event.target : null;
    const svg = target?.closest<SVGSVGElement>(".wm-pele svg, .wm-diagram-viewer svg.pele");
    if (current && current !== svg) { clear(current); current = null; }
    // Never alter styles while a region is being chosen or composed: capture compares them.
    if (!svg || svg.closest(".is-selecting-region") || document.querySelector(".wm-region-composer")) return;
    const item = target!.closest(ITEMS);
    current = svg;
    if (item && svg.contains(item)) trace(svg, item); else clear(svg);
  });
  root.documentElement.addEventListener("pointerleave", () => { if (current) clear(current); current = null; });
}
