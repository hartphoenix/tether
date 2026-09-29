type ApplyPreview = (value: string | HTMLElement | null) => void;
let library: Promise<typeof import("mermaid")> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** Crepe retains editable source; only Mermaid blocks trigger the separate renderer download. */
export function renderMermaidPreview(language: string, source: string, apply: ApplyPreview): null | undefined {
  if (language.toLowerCase() !== "mermaid" || !source.trim()) return null;
  queue = queue.catch(() => {}).then(async () => {
    try {
      library ??= import("mermaid").catch(error => { library = undefined; throw error; });
      const { default: mermaid } = await library;
      const style = getComputedStyle(document.querySelector(".milkdown") ?? document.documentElement);
      const color = (name: string, fallback: string) => style.getPropertyValue(`--wm-color-${name}`).trim() || style.getPropertyValue(`--crepe-color-${name}`).trim() || fallback;
      const fontFamily = style.getPropertyValue("--wm-font-code").trim() || style.getPropertyValue("--crepe-font-code").trim() || "monospace";
      const background = color("background", "#ffffff"), surface = color("surface", "#f5f5f5");
      const ink = color("on-surface", "#222222"), outline = color("outline", "#777777");
      // Measure labels only after the selected code font is available.
      await document.fonts.load(`16px ${fontFamily}`);
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", suppressErrorRendering: true,
        themeVariables: {
          darkMode: document.documentElement.style.colorScheme === "dark", fontFamily,
          background, primaryColor: surface, primaryTextColor: ink, primaryBorderColor: outline,
          secondaryColor: color("surface-low", surface), secondaryTextColor: ink, secondaryBorderColor: outline,
          tertiaryColor: background, tertiaryTextColor: ink, tertiaryBorderColor: outline,
          lineColor: color("on-surface-variant", ink), textColor: ink,
          mainBkg: surface, nodeBorder: outline, clusterBkg: color("surface-low", surface), clusterBorder: outline,
          edgeLabelBackground: background, titleColor: ink,
          actorBkg: surface, actorTextColor: ink, actorBorder: outline, actorLineColor: outline,
          signalColor: ink, signalTextColor: ink, labelBoxBkgColor: surface, labelBoxBorderColor: outline, labelTextColor: ink,
          noteBkgColor: color("surface-low", surface), noteTextColor: ink, noteBorderColor: outline,
          activationBkgColor: surface, activationBorderColor: outline,
        },
      });
      const { svg } = await mermaid.render(`tether-diagram-${++nextId}`, source);
      const preview = `<div class="wm-mermaid">${svg}</div>`;
      apply(preview);
    } catch {
      // Preserve the source and the editor's Edit toggle, including on malformed diagrams.
      const message = document.createElement("div");
      message.className = "wm-mermaid-error";
      message.textContent = "Diagram unavailable. Choose Edit to inspect the Mermaid source.";
      apply(message);
    }
  });
  return undefined;
}
