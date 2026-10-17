import { builtInDesign, type ThemePreferences } from "../shared/themes";

const hexColor = /^#[0-9a-f]{3,8}$/i;

/**
 * Paints the reader's first frame in its theme. The stylesheet defaults to a dark page until the
 * reader's script applies the full design after bootstrap, which flashed dark in light themes.
 */
export function themedReaderHtml(response: Response, preferences: Pick<ThemePreferences, "theme" | "customThemes">): Response {
  const design = builtInDesign(preferences.theme) ?? preferences.customThemes?.find(theme => theme.id === preferences.theme);
  if (!design || !builtInDesign(design.base)) return response;
  const style = [`color-scheme:${design.base.endsWith("-dark") ? "dark" : "light"}`];
  if (hexColor.test(design.colors.background)) style.push(`--wm-page-background:${design.colors.background}`);
  if (hexColor.test(design.colors["on-background"])) style.push(`--wm-page-color:${design.colors["on-background"]}`);
  return new HTMLRewriter().on("html", {
    element(element) {
      element.setAttribute("data-wm-theme", design.base);
      element.setAttribute("style", style.join(";"));
    },
  }).transform(response);
}
