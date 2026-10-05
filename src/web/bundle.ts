import { extname, join } from 'node:path';
import { readdir, mkdir, readFile, writeFile, stat, unlink, utimes } from 'node:fs/promises';
import { runtimeRoot } from '../runtime-paths';
import { buildWeb } from './build';

export type WebResponder = ((request: Request) => Response) & { assets?: WebResponder };
export const ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const isApplicationAsset = (path: string) => /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|png|woff2?|ttf)$/.test(path);
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

/** Keep only application bytes across restarts; private responses never enter this store. */
export async function createWebBundleResponder(cacheDir?: string): Promise<WebResponder> {
  const installed = process.env.TETHER_INSTALL_ROOT;
  const assets = installed
    ? new Map(await Promise.all((await readdir(join(runtimeRoot(), 'dist'))).map(async name => [name, new Uint8Array(await readFile(join(runtimeRoot(), 'dist', name)))] as const)))
    : await buildWeb();
  if (cacheDir) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const now = new Date();
    for (const [name, bytes] of assets) {
      if (!isApplicationAsset(`/assets/${name}`)) continue;
      const path = join(cacheDir, name);
      await writeFile(path, bytes);
      await utimes(path, now, now);
    }
    for (const name of await readdir(cacheDir)) {
      if (!isApplicationAsset(`/assets/${name}`) || assets.has(name)) continue;
      const path = join(cacheDir, name);
      if (Date.now() - (await stat(path)).mtimeMs > ASSET_RETENTION_MS) await unlink(path);
      else assets.set(name, new Uint8Array(await readFile(path)));
    }
  }
  const compressed = new Map([...assets].filter(([name]) => /\.(js|css)$/.test(name)).map(([name, bytes]) => [name, Bun.gzipSync(bytes)]));
  const respond: WebResponder = request => {
    const pathname = new URL(request.url).pathname;
    const name = pathname.endsWith('/') ? 'index.html' : pathname.split('/').at(-1)!;
    const asset = assets.get(name);
    if (!asset || (pathname.startsWith('/assets/') && !isApplicationAsset(pathname))) return Response.json({ error: { code: 'not_found', message: 'Application asset unavailable. Reload to use the current build.' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
    const gzip = /(?:^|,)\s*gzip\s*(?:;\s*q=(?!0(?:\.0*)?(?:\s*,|\s*$))[0-9.]+)?\s*(?:,|$)/.test(request.headers.get('accept-encoding') ?? '') && compressed.has(name);
    return new Response(gzip ? compressed.get(name)! : asset, { headers: {
      'cache-control': name === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'content-type': contentTypes[extname(name)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff', 'vary': 'Accept-Encoding',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    } });
  };
  return Object.assign(respond, { assets: respond });
}
