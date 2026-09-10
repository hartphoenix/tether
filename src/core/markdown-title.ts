import { unified } from "unified";
import remarkParse from "remark-parse";
import { prepareMarkdown } from "./markdown-codec";

const parser = unified().use(remarkParse);
type Node = { type: string; depth?: number; value?: string; alt?: string; children?: Node[] };

/** First nonempty heading at the highest heading level present. */
export function markdownTitle(source: string): string | null {
  const tree = parser.parse(prepareMarkdown(source).editorMarkdown) as Node;
  let title: string | null = null;
  let level = Infinity;
  const text = (node: Node): string => node.value ?? node.alt ?? (node.children ?? []).map(text).join("");
  const visit = (node: Node) => {
    if (node.type === "heading" && node.depth! < level) {
      const value = text(node).replace(/\s+/g, " ").trim();
      if (value) { title = value; level = node.depth!; }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return title;
}
