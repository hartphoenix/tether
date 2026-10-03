type ApplyPreview = (value: string | HTMLElement | null) => void;
let library: Promise<typeof import("mermaid")> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
// Keep templates, not mounted nodes: each insertion needs unique SVG/CSS IDs.
const previews = new Map<string, string>();
function instantiate(svg: string): string {
  const root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')!;
  const prefix = `tether-diagram-${++nextId}`;
  const ids = new Map<string, string>();
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    if (node.id) ids.set(node.id, `${prefix}-${ids.size}`);
  }
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      if (attr.name === 'id') attr.value = ids.get(attr.value)!;
      else if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby') attr.value = attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ');
      else if (attr.localName === 'href' && attr.value.startsWith('#')) attr.value = '#' + (ids.get(attr.value.slice(1)) ?? attr.value.slice(1));
      else attr.value = attr.value.replace(/url\(["']?#([^"')]+)["']?\)/g, (match, id) => ids.has(id) ? `url(#${ids.get(id)})` : match);
    }
    if (node.localName === 'style') {
      node.textContent = node.textContent!.replace(/#([\w-]+)/g, (match, id) => ids.has(id) ? `#${ids.get(id)}` : match);
    }
  }
  return `<div class="wm-mermaid">${new XMLSerializer().serializeToString(root)}</div>`;
}

/** Crepe retains editable source; only Mermaid blocks trigger the separate renderer download. */
export function renderMermaidPreview(language: string, source: string, apply: ApplyPreview): string | null | undefined {
  if (language.toLowerCase() !== "mermaid" || !source.trim()) return null;
  const style = getComputedStyle(document.querySelector(".milkdown") ?? document.documentElement);
  const color = (name: string, fallback: string) => style.getPropertyValue(`--wm-color-${name}`).trim() || style.getPropertyValue(`--crepe-color-${name}`).trim() || fallback;
  const fontFamily = style.getPropertyValue("--wm-font-code").trim() || style.getPropertyValue("--crepe-font-code").trim() || "monospace";
  const background = color("background", "#ffffff"), surface = color("surface", "#f5f5f5");
  const ink = color("on-surface", "#222222"), outline = color("outline", "#777777");
  const options = {
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
  } as const;
  const key = JSON.stringify([source, options]);
  const cached = previews.get(key);
  if (cached && document.fonts.check(`16px ${fontFamily}`)) {
    previews.delete(key); previews.set(key, cached);
    return instantiate(cached);
  }
  queue = queue.catch(() => {}).then(async () => {
    try {
      library ??= import("mermaid").catch(error => { library = undefined; throw error; });
      const { default: mermaid } = await library;
      // Measure labels only after the selected code font is available.
      await document.fonts.load(`16px ${fontFamily}`);
      let entry = previews.get(key);
      if (!entry) {
        mermaid.initialize(options);
        const id = `tether-diagram-${++nextId}`;
        const { svg } = await mermaid.render(id, source);
        entry = svg;
        previews.set(key, entry);
        if (previews.size > 32) previews.delete(previews.keys().next().value!);
      }
      apply(instantiate(entry));
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
