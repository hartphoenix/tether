import type { DiagramPalette } from "../shared/diagram-theme";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { DiagramRenderer } from "./diagram-renderer";

/** Only sources already present in the authorized document reach the renderer. */
export async function documentDiagrams(body: string, renderer: DiagramRenderer, palette?: DiagramPalette, signal?: AbortSignal): Promise<Record<string, string | null>> {
  const sources = new Set<string>();
  const visit = (node: { type: string; lang?: string | null; value?: string; children?: any[] }) => {
    if (node.type === "code" && node.lang?.toLowerCase() === "mermaid" && node.value?.trim()) sources.add(node.value.trim());
    for (const child of node.children ?? []) visit(child);
  };
  visit(unified().use(remarkParse).parse(body));
  const previews: Record<string, string | null> = Object.create(null);
  let count = 0, svgBytes = 0;
  for (const source of sources) {
    signal?.throwIfAborted();
    if (++count > 32 || svgBytes >= 4 * 1024 * 1024 || Buffer.byteLength(source) > 50 * 1024) { previews[source] = null; continue; }
    try {
      const svg = await renderer.render(source, palette?.dark ?? false, palette);
      svgBytes += Buffer.byteLength(svg);
      // Bound the aggregate mobile payload as well as each individual SVG.
      previews[source] = svgBytes <= 4 * 1024 * 1024 ? svg : null;
    }
    catch { previews[source] = null; }
  }
  return previews;
}
