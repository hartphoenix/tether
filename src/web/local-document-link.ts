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

type LocalLink = { target: string; format: "wikilink" | "markdown" };

/** Whether a local link names a Markdown document (by extension, or none for a wikilink). */
export function opensAsDocument(link: LocalLink): boolean {
  const bare = (link.format === "wikilink" ? link.target.split("|", 1)[0]!.split("#", 1)[0]! : link.target.split(/[?#]/, 1)[0]!).trim();
  const name = bare.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return link.format === "wikilink";
  return /^\.(md|markdown)$/i.test(name.slice(dot));
}

/** The session-relative route a new tab loads to open a linked document. */
export function documentLinkPath(link: LocalLink): string {
  return `api/link?target=${encodeURIComponent(link.target)}&format=${link.format}`;
}
