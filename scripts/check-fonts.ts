/** Compare the external-font build against the previous embedded-font build in both engines. */
import { chromium, webkit, type Page } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { strict as assert } from 'node:assert';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
import { builtInThemes, builtInDesign } from '../src/shared/themes';

const directory = await mkdtemp('/tmp/tether-font-geometry-');
const path = join(directory, 'fonts.md');
await writeFile(path, '# Typography\n\nSelect these words. **Bold writing** and *italic writing*. Ελληνικά Кириллица Tiếng Việt.\n\n$x^2 + y^2 = z^2$\n\n| Name | Value |\n| --- | --- |\n| Math | 123 |\n\n```typescript\nconst value = 12;\n```\n');
const old = await Bun.build({ entrypoints: ['src/web/app.ts', 'src/web/index.html'], target: 'browser', minify: true, splitting: true, naming: '[name]-[hash].[ext]' });
assert(old.success);
const assets = new Map(old.outputs.map(output => [basename(output.path), output]));
const index = old.outputs.find(output => output.path.endsWith('.html'))!;
const baseline = createDaemon({ config: resolveConfig({ runtimeDir: join(directory, 'old-runtime'), configDir: join(directory, 'old-config') }), web: request => {
  const pathname = new URL(request.url).pathname;
  const output = pathname.endsWith('/') ? index : assets.get(pathname.split('/').at(-1)!);
  return output ? new Response(output, { headers: { 'content-type': pathname.endsWith('/') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript' } }) : new Response(null, { status: 404 });
} });
const current = createDaemon({ config: resolveConfig({ runtimeDir: join(directory, 'new-runtime'), configDir: join(directory, 'new-config') }), web: await createWebBundleResponder() });
const measure = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.querySelectorAll<HTMLElement>('.ProseMirror h1, .ProseMirror p, .ProseMirror strong, .ProseMirror em, .ProseMirror .katex, .ProseMirror table')].map(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { text: element.textContent, font: style.fontFamily, width: box.width, height: box.height, top: box.top };
  });
});
try {
  await Promise.all([baseline.ready, current.ready]);
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    const browser = await engine.launch();
    try {
      const pages = await Promise.all([baseline, current].map(async daemon => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
        await page.locator('.katex').first().waitFor();
        return page;
      }));
      for (const theme of builtInThemes) {
        await Promise.all(pages.map(async page => {
          await page.evaluate(async theme => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) }); dispatchEvent(new Event('online')); }, theme.value);
          await page.waitForFunction(design => document.documentElement.dataset.wmTheme === design.base && document.documentElement.style.getPropertyValue('--wm-color-primary') === design.colors.primary, builtInDesign(theme.value)!);
        }));
        const [before, after] = await Promise.all(pages.map(measure));
        assert.equal(after!.length, before!.length);
        for (let i = 0; i < before!.length; i++) {
          assert.equal(after![i]!.text, before![i]!.text); assert.equal(after![i]!.font, before![i]!.font);
          for (const metric of ['width', 'height', 'top'] as const) assert(Math.abs(after![i]![metric] - before![i]![metric]) < 1, `${name} ${theme.value} ${metric} differs`);
        }
      }
      console.log(`${name}: all ${builtInThemes.length} themes match embedded-font geometry for math, non-Latin text, bold, italic, wrapping and tables`);
    } finally { await browser.close(); }
  }
} finally { await baseline.stop(); await current.stop(); await rm(directory, { recursive: true, force: true }); }
