import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { prepareMarkdown } from "../core/markdown-codec";
import { createAnchor, type AnnotationAnchor } from "../core/annotation-ledger";
import { bodyRevision } from "../core/index";
import { createHash } from "node:crypto";

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = { type: string; value?: string; children?: Node[] };

/** Markdown text blocks in the same order as the editor's quote projection. */
export function markdownProjection(body: string): string {
  const tree = parser.parse(prepareMarkdown(body).editorMarkdown) as Node;
  const blocks: string[] = [];
  function inline(node: Node): string {
    if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
    if (node.type === "break") return "\n";
    if (node.type === "image" || node.type === "imageReference") return "\uFFFC";
    return (node.children ?? []).map(inline).join("");
  }
  function collect(node: Node): void {
    if (["paragraph", "heading", "tableCell"].includes(node.type)) blocks.push(inline(node));
    else if (node.type === "code") blocks.push(node.value ?? "");
    else for (const child of node.children ?? []) collect(child);
  }
  collect(tree);
  return blocks.join("\n");
}

function candidateId(revision: string, quote: string, start: number): string {
  return `q-${createHash("sha256").update(JSON.stringify([revision, quote, start])).digest("hex")}`;
}

export function quoteCandidates(body: string, quote: string, options: { maxBytes?: unknown; limit?: unknown } = {}) {
  if (!quote.trim()) throw Object.assign(new Error("A nonempty quote is required."), { code: "invalid_request", status: 400 });
  const revision = bodyRevision(body);
  const projection = markdownProjection(body);
  const maxBytes = Math.max(2048, Math.min(typeof options.maxBytes === "number" ? options.maxBytes : 8192, 65536));
  const limit = Math.max(1, Math.min(typeof options.limit === "number" ? options.limit : 10, 100));
  const candidates: Array<{ candidateId: string; before: string; after: string }> = [];
  let omitted = false;
  let start = projection.indexOf(quote);
  const result = { bodyRevision: revision, candidates, omitted, maxBytes };
  while (start >= 0) {
    const candidate = { candidateId: candidateId(revision, quote, start), before: projection.slice(Math.max(0, start - 120), start), after: projection.slice(start + quote.length, start + quote.length + 120) };
    candidates.push(candidate);
    if (candidates.length > limit || Buffer.byteLength(JSON.stringify(result)) > maxBytes - 100) { candidates.pop(); omitted = true; break; }
    start = projection.indexOf(quote, start + 1);
  }
  return { ...result, omitted };
}

export function anchorForQuote(body: string, quote: string, revision: string, selectedCandidate?: string): AnnotationAnchor {
  if (!quote.trim()) throw Object.assign(new Error("A nonempty quote is required."), { code: "invalid_request" });
  const projection = markdownProjection(body);
  let start = projection.indexOf(quote);
  if (start < 0) throw Object.assign(new Error("The quote is not in the current document."), { code: "quote_not_found" });
  if (selectedCandidate) {
    while (start >= 0 && candidateId(revision, quote, start) !== selectedCandidate) start = projection.indexOf(quote, start + 1);
    if (start < 0) throw Object.assign(new Error("The quote candidate is unavailable. Read candidates again."), { code: "quote_candidate_stale", status: 409 });
  } else if (projection.indexOf(quote, start + 1) >= 0) throw Object.assign(new Error("The quote occurs more than once. Read quote-candidates or include more surrounding text."), { code: "quote_ambiguous", details: quoteCandidates(body, quote) });
  return createAnchor(projection, start, start + quote.length, revision as `sha256:${string}`);
}
