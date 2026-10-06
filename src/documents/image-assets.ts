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
export async function readReferencedImage(documentPath: string, markdown: string, source: string): Promise<{bytes: Uint8Array; contentType: string; etag: string}> {
  const fail = (code: string, message: string, status: number): never => { throw Object.assign(new Error(message), {code,status}); };
  if (!source || !imageReferences(markdown).has(source)) fail("image_not_referenced", "Image is not referenced by this document.", 403);
  let relative: string;
  try { relative = decodeURIComponent(source.split(/[?#]/, 1)[0]!); } catch { return fail("invalid_request", "Invalid image path.", 400); }
  if (!relative || isAbsolute(relative) || /^[a-z][a-z\d+.-]*:/i.test(relative) || relative.includes("\0") || relative.includes("\\")) fail("invalid_request", "Expected a document-relative image path.", 400);
  const requested = resolve(dirname(documentPath), relative);
  let canonical: string;
  try { canonical = await realpath(requested); }
  catch { return fail("file_missing", "Image not found.", 404); }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("unsupported_image", "Not an image file.", 415);
    if (before.size > MAX_IMAGE_BYTES) fail("input_too_large", "Image exceeds 32 MiB.", 413);
    const bytes = await handle.readFile();
    const after = await handle.stat(), current = await stat(canonical);
    if (await realpath(requested) !== canonical || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw pathChanged();
    if (bytes.length > MAX_IMAGE_BYTES) fail("input_too_large", "Image exceeds 32 MiB.", 413);
    const contentType = imageType(bytes, canonical);
    if (!contentType) return fail("unsupported_image", "Unsupported image content.", 415);
    return { bytes, contentType, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
  } finally { await handle.close(); }
}

export function imageResponse(asset: {bytes: Uint8Array;contentType: string;etag: string}, request: Request): Response {
  const headers = {
    "content-type": asset.contentType, etag: asset.etag, "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  return request.headers.get("if-none-match") === asset.etag ? new Response(null, {status:304,headers}) : new Response(Buffer.from(asset.bytes), {headers});
}
export class ImageAssets {
  async response(request: Request, grant: DocumentSession, document: DocumentSnapshot): Promise<Response> {
    try { return imageResponse(await readReferencedImage(grant.realPath, document.body, new URL(request.url).searchParams.get("src") ?? ""), request); }
    catch (error) {
      const status = (error as {status?:number}).status;
      if (status && status !== 409) return new Response((error as Error).message, {status});
      throw error;
    }
  }
}
