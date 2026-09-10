import { wikilinkRoute } from "../core/markdown-codec";

/** Inspect the authored href before the browser resolves it against a session URL. */
export function localDocumentLink(href: string): { target: string; format: "wikilink" | "markdown" } | null {
  if (href.startsWith(wikilinkRoute)) {
    try { return { target: decodeURIComponent(href.slice(wikilinkRoute.length)), format: "wikilink" }; }
    catch { return null; }
  }
  if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  return { target: href, format: "markdown" };
}
