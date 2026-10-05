import { expect, test } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ASSET_RETENTION_MS, createWebBundleResponder } from '../src/web/bundle';

test('application URLs are shared and fonts retain declarations without embedded bytes', async () => {
  const respond = await createWebBundleResponder();
  const first = await respond(new Request('http://localhost/s/first/')).text();
  expect(await respond(new Request('http://localhost/s/second/')).text()).toBe(first);
  expect(first).not.toContain('token=');
  const paths = [...first.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  expect(paths.some(path => path.endsWith('.js'))).toBe(true);
  const css = await respond(new Request(`http://localhost${paths.find(path => path.endsWith('.css'))}`)).text();
  expect(css).not.toContain('data:font');
  expect(css).not.toContain('fonts.googleapis.com');
  for (const family of ['Hanken Grotesk', 'Source Serif 4', 'Source Sans 3', 'Cabin', 'Alegreya', 'DM Mono']) expect(css).toContain(family);
  expect(css).toContain('unicode-range:');
  const fonts = [...css.matchAll(/url\(["']?(\/assets\/[^)'" ]+\.(?:woff2?|ttf))/g)].map(match => match[1]);
  expect(fonts.length).toBe(126);
  for (const path of fonts) {
    const response = respond(new Request(`http://localhost${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('font/');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  }
  const compressed = respond(new Request(`http://localhost${paths.find(path => path.endsWith('.css'))}`, { headers: { 'accept-encoding': 'gzip' } }));
  expect(compressed.headers.get('content-encoding')).toBe('gzip');
  expect(new TextDecoder().decode(Bun.gunzipSync(await compressed.arrayBuffer()))).toBe(css);
  expect(respond(new Request('http://localhost/assets/index.html')).status).toBe(404);
});

test('prior lazy assets survive restart for seven days; expired files are removed', async () => {
  const dir = await mkdtemp('/tmp/tether-assets-');
  try {
    const old = 'lazy-12345678.js', expired = 'lazy-87654321.js';
    await writeFile(join(dir, old), 'old lazy module');
    await writeFile(join(dir, expired), 'expired module');
    const past = new Date(Date.now() - ASSET_RETENTION_MS - 1000);
    await utimes(join(dir, expired), past, past);
    const responder = await createWebBundleResponder(dir);
    expect(await responder(new Request(`http://localhost/assets/${old}`)).text()).toBe('old lazy module');
    expect(responder(new Request(`http://localhost/assets/${expired}`)).status).toBe(404);
    expect(await Bun.file(join(dir, expired)).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
