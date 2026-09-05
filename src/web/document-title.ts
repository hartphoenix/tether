import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";

export function filenameStem(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) || "Markdown";
  const stem = filename.replace(/\.(?:md|markdown)$/i, "");
  return stem || "Markdown";
}

export function documentTabTitle(path: string, documentNode: ProseMirrorNode): string {
  let firstH1: string | undefined;
  documentNode.descendants((node) => {
    if (firstH1 || node.type.name !== "heading" || node.attrs.level !== 1) return;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text) firstH1 = text;
  });
  return firstH1 ?? filenameStem(path);
}
