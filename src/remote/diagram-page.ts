import { diagramThemeOptions, type DiagramPalette } from "../shared/diagram-theme";
// Browser entry for the host diagram renderer: bundled as one module and injected into a blank page.
import mermaid from "mermaid";

const FONT_NAME = "Tether Diagram Mono";
const FONT_FAMILY = `"${FONT_NAME}", monospace`;
const MAX_SVG_CHARS = 2 * 1024 * 1024;

async function tetherRender(source: string, dark: boolean, palette?: DiagramPalette): Promise<string> {
  // Measure labels only after the embedded font is available.
  await document.fonts.load(`16px "${FONT_NAME}"`);
  mermaid.initialize(palette ? diagramThemeOptions(palette, FONT_FAMILY) : {
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true,
    theme: dark ? "dark" : "default", fontFamily: FONT_FAMILY, themeVariables: { fontFamily: FONT_FAMILY },
  });
  try {
    const { svg } = await mermaid.render("tether-diagram", source);
    const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
    if (!root) throw new Error("Mermaid returned no SVG");
    root.style.background = palette?.background ?? (dark ? "#1e1e1e" : "#ffffff");
    root.style.colorScheme = dark ? "dark" : "light";
    // Carry the measuring font so the phone draws labels with identical metrics.
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = document.getElementById("tether-diagram-font")?.textContent ?? "";
    root.prepend(style);
    const result = new XMLSerializer().serializeToString(root);
    if (result.length > MAX_SVG_CHARS) throw new Error("Rendered diagram is too large");
    return result;
  } finally {
    document.body.replaceChildren();
  }
}

Object.assign(globalThis, { tetherRender });
