import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { prepareMarkdown } from "../core/markdown-codec";
import type { DocumentSnapshot } from "../shared/contracts";
import type { DocumentSession } from "./document-service";
import { pathChanged } from "./safe-files";

const parser = unified().use(remarkParse).use(remarkGfm);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
type Node = { type: string; url?: string; identifier?: string; children?: Node[] };

function imageReferences(markdown: string): Set<string> {
  const images = new Set<string>();
  const definitions = new Map<string, string>();
  const references: string[] = [];
  const visit = (node: Node) => {
    if (node.type === "image" && node.url) images.add(node.url);
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if (node.type === "imageReference" && node.identifier) references.push(node.identifier);
    node.children?.forEach(visit);
  };
  visit(parser.parse(prepareMarkdown(markdown).editorMarkdown) as Node);
  for (const id of references) { const url = definitions.get(id); if (url) images.add(url); }
  return images;
}

function imageType(bytes: Buffer, path: string): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(bytes.toString("ascii", 8, 12))) return "image/avif";
  if (extname(path).toLowerCase() === ".svg" && /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString("utf8", 0, 4096))) return "image/svg+xml";
  return undefined;
}

/** Document references grant access to individual image files, never a directory. */
export class ImageAssets {
  private readonly references = new WeakMap<DocumentSession, { revision: string; urls: Set<string> }>();

  async response(request: Request, grant: DocumentSession, document: DocumentSnapshot): Promise<Response> {
    const source = new URL(request.url).searchParams.get("src");
    let references = this.references.get(grant);
    if (!references || references.revision !== document.bodyRevision) {
      references = { revision: document.bodyRevision, urls: imageReferences(document.body) };
      this.references.set(grant, references);
    }
    if (!source || !references.urls.has(source)) return new Response("Image is not referenced by this document.", { status: 403 });
    const pathPart = source.split(/[?#]/, 1)[0]!;
    let relative: string;
    try { relative = decodeURIComponent(pathPart); } catch { return new Response("Invalid image path.", { status: 400 }); }
    if (!relative || isAbsolute(relative) || /^[a-z][a-z\d+.-]*:/i.test(relative) || relative.includes("\0") || relative.includes("\\")) {
      return new Response("Expected a document-relative image path.", { status: 400 });
    }
    const requested = resolve(dirname(grant.realPath), relative);
    let canonical: string;
    try { canonical = await realpath(requested); }
    catch { return new Response("Image not found.", { status: 404 }); }
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) return new Response("Not an image file.", { status: 415 });
      if (before.size > MAX_IMAGE_BYTES) return new Response("Image exceeds 32 MiB.", { status: 413 });
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await stat(canonical);
      if (await realpath(requested) !== canonical || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw pathChanged();
      if (bytes.length > MAX_IMAGE_BYTES) return new Response("Image exceeds 32 MiB.", { status: 413 });
      const type = imageType(bytes, canonical);
      if (!type) return new Response("Unsupported image content.", { status: 415 });
      const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
      const headers = {
        "content-type": type, "etag": etag, "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      };
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(bytes, { headers });
    } finally { await handle.close(); }
  }
}
