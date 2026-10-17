/** Map only local image destinations; keep authored Markdown and remote URLs intact. */
export function imageDisplayUrl(source: string, locationVersion?: number): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return source;
  const fragment = source.indexOf("#");
  return `api/image?src=${encodeURIComponent(source)}${locationVersion === undefined ? "" : `&locationVersion=${locationVersion}`}${fragment < 0 ? "" : source.slice(fragment)}`;
}

// CORS is attempted during the initial display load, never when commenting.
// Failed CORS loads retain the ordinary image URL and normal browser viewing.
const remoteImages = new Map<string, Promise<string>>();
let remoteBytes = 0, generation = 0;
export function clearImageDisplayCache(): void {
  generation++; for (const pending of remoteImages.values()) void pending.then(url => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); });
  remoteImages.clear(); remoteBytes = 0;
}
export function loadImageDisplayUrl(source: string, locationVersion?: number): string | Promise<string> {
  if (!/^(?:https?:|\/\/)/i.test(source)) return imageDisplayUrl(source, locationVersion);
  const existing = remoteImages.get(source); if (existing) return existing;
  if (remoteImages.size >= 32) return source;
  const current = generation;
  const pending = (async () => {
    try {
      const response = await fetch(source, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.body) return source;
      const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > 32 * 1024 * 1024 || remoteBytes + size > 64 * 1024 * 1024) { await reader.cancel(); return source; }
        chunks.push(new Uint8Array(next.value));
      } } finally { reader.releaseLock(); }
      if (current !== generation || remoteBytes + size > 64 * 1024 * 1024) return source;
      remoteBytes += size;
      return URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' }));
    } catch { return source; }
  })(); remoteImages.set(source, pending); return pending;
}
