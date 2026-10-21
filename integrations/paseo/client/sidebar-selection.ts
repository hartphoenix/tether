import { tetherThemes } from "./themes";

// Paseo 0.12 light themes paint the selected sidebar row with `ring`, which also sets the faintest text.
// Off-contract: restyle the row by test ID and aria-selected. If Paseo changes either, the row falls back
// to the theme's ring compromise.
const selected: Record<string, string> = { "tether": "#c4d3ce", "light-treason": "#c4cdd6" };
const ROW = '[data-testid^="sidebar-workspace-row-"][aria-selected="true"]';
const css = `
:root[data-tether-sidebar-selected] ${ROW} { background-color:var(--tc-sidebar-selected) !important; }
:root[data-tether-sidebar-selected] ${ROW} [data-testid="sidebar-workspace-trailing-scrim"] stop { stop-color:var(--tc-sidebar-selected) !important; }
`;

export function activeLightTheme(read: (name: string) => string): string | null {
  const value = (name: string) => read(`--colors-${name}`).trim().toLowerCase();
  const match = tetherThemes.find(t => t.appearance === "light" && t.colors.background === value("surface0") && t.colors.foreground === value("foreground") && t.colors.accent === value("accent"));
  return match && selected[match.id] ? match.id : null;
}

export function startSidebarSelection(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement, style = document.createElement("style");
  style.textContent = css; document.head.append(style);
  let current: string | null = null;
  const sync = () => {
    const css = getComputedStyle(root), id = activeLightTheme(name => css.getPropertyValue(name));
    if (id === current) return;
    current = id;
    if (id) { root.style.setProperty("--tc-sidebar-selected", selected[id]!); root.dataset.tetherSidebarSelected = id; }
    else { root.style.removeProperty("--tc-sidebar-selected"); delete root.dataset.tetherSidebarSelected; }
  };
  // Theme switches change the root class or rewrite theme stylesheets; the interval covers constructed sheets.
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const timer = setInterval(sync, 2000);
  sync();
  return () => {
    observer.disconnect(); clearInterval(timer); style.remove();
    root.style.removeProperty("--tc-sidebar-selected"); delete root.dataset.tetherSidebarSelected;
  };
}
