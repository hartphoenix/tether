const wikilinkPattern = /\[\[([^\]\n]+)\]\]/g;
export const wikilinkRoute = "/_tether/wikilink/";
const encodedWikilinkPattern = /\[([^\]\n]*)\]\((?:https?:\/\/[^/\s)]+)?\/(?:_tether|_wave-markdown)\/wikilink\/([^\s)]+)\)/g;

export type PreparedMarkdown = {
  editorMarkdown: string;
  frontmatter: string;
};

export function prepareMarkdown(source: string): PreparedMarkdown {
  const frontmatterMatch = source.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const body = frontmatterMatch?.[2] ?? source;
  const editorMarkdown = body.replace(wikilinkPattern, (_match, value: string) => {
    const label = value.includes("|") ? value.slice(value.lastIndexOf("|") + 1) : value;
    return `[${label}](${wikilinkRoute}${encodeURIComponent(value)})`;
  });
  return { editorMarkdown, frontmatter };
}

export function restoreMarkdown(editorMarkdown: string, frontmatter: string): string {
  const body = editorMarkdown.replace(encodedWikilinkPattern, (_match, _label: string, value: string) => {
    try {
      return `[[${decodeURIComponent(value)}]]`;
    } catch {
      return _match;
    }
  });
  return frontmatter + body;
}
