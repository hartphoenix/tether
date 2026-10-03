import { chromium, webkit, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const outdir = await mkdtemp(join(tmpdir(), 'tether-block-lifecycle-'));
const build = await Bun.build({entrypoints:['./tests/browser/code-block-lifecycle-fixture.ts'],outdir,target:'browser',splitting:true});
if (!build.success) throw new Error(String(build.logs));
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('<link rel="stylesheet" href="/code-block-lifecycle-fixture.css"><div id="workspace"><main id="editor"></main></div><script type="module" src="/code-block-lifecycle-fixture.js"></script>', {headers:{'Content-Type':'text/html'}});
  if (!build.outputs.some(output => '/' + output.path.split('/').pop() === path)) return new Response(null,{status:404});
  return new Response(Bun.file(join(outdir,path.slice(1))));
}});
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function settled(page: Page) {
  await page.waitForFunction(() => {
    const block = document.querySelector<HTMLElement>('.milkdown-code-block');
    return block?.querySelector('.cm-editor') && !block.style.height && !block.textContent?.includes('Rendering diagram…');
  });
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.milkdown-code-block')!;
    const scroller = document.querySelector<HTMLElement>('.wm-document-scroll')!;
    const anchor = [...document.querySelectorAll('.ProseMirror p')].find(p => p.textContent?.startsWith('Paragraph 35.'))!;
    return {height:block.getBoundingClientRect().height,scroll:scroller.scrollTop,extent:scroller.scrollHeight,anchor:anchor.getBoundingClientRect().top};
  });
}
async function cycle(page: Page, label: string) {
  await settled(page);
  const mounted = await snapshot(page);
  await page.evaluate(() => {
    // Disable browser compensation so a height regression cannot be hidden.
    document.querySelector<HTMLElement>('.wm-document-scroll')!.style.overflowAnchor = 'none';
    [...document.querySelectorAll('.ProseMirror p')].find(p => p.textContent?.startsWith('Paragraph 35.'))!.scrollIntoView({block:'center'});
  });
  await page.waitForTimeout(150);
  const before = await snapshot(page);
  await page.waitForSelector('.milkdown-code-block-placeholder', {timeout:8000,state:'attached'});
  await page.waitForTimeout(100);
  const after = await snapshot(page);
  for (const key of ['height','scroll','extent','anchor'] as const) check(Math.abs(before[key]-after[key]) < 1, `${label}: teardown changed ${key}: ${JSON.stringify({before,after})}`);
  await page.evaluate(() => {
    const block = document.querySelector('.milkdown-code-block')!;
    (window as any).heights = [];
    (window as any).heightObserver = new ResizeObserver(() => (window as any).heights.push(block.getBoundingClientRect().height));
    (window as any).heightObserver.observe(block);
    document.querySelector('.wm-document-scroll')!.scrollTop = 0;
  });
  await settled(page);
  const heights = await page.evaluate(() => { (window as any).heightObserver.disconnect(); return (window as any).heights as number[]; });
  check(heights.every(h => Math.abs(h-mounted.height)<1), `${label}: remount changed height: ${JSON.stringify(heights)}, expected ${mounted.height}`);
}
try {
  for (const engine of [chromium,webkit]) {
    const browser = await engine.launch({headless:true});
    try {
      await Promise.all([.75,1,1.75].map(async scale => {
        for (const kind of ['mermaid','code','error']) {
          const page = await browser.newPage({viewport:{width:1100,height:900}});
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          const label = `${engine.name()} ${kind} scale=${scale}`;
          try {
            await page.goto(`${server.url}?kind=${kind}&scale=${scale}`);
            await page.waitForFunction(() => !!(window as any).lifecycle);
            await cycle(page,label);
            if (kind === 'mermaid') {
              const cache = await page.evaluate(() => {
                const api = (window as any).lifecycle;
                const copies = api.cachedCopies();
                const ids = copies.flatMap((html: string) => [...new DOMParser().parseFromString(html,'text/html').querySelectorAll('[id]')].map(node => node.id));
                return {stats:api.stats(),ids};
              });
              check(cache.stats.cacheHits > 0 && cache.stats.renders === 1, `${label}: remount did not use cache: ${JSON.stringify(cache)}`);
              check(cache.ids.length > 2 && new Set(cache.ids).size === cache.ids.length, `${label}: duplicate SVG IDs`);
              await page.getByRole('button',{name:'Edit',exact:true}).click();
              await cycle(page,`${label} source visible`);
              check(await page.locator('.codemirror-host').isVisible(), `${label}: Edit state lost`);
              await page.getByRole('button',{name:'Hide',exact:true}).click();
              const old = await snapshot(page);
              await page.evaluate(() => (window as any).lifecycle.setSource('flowchart LR\n X[Changed] --> Y[New]'));
              await page.waitForFunction(() => document.querySelector('.wm-mermaid')?.textContent?.includes('Changed'));
              await settled(page);
              check((await snapshot(page)).height < old.height, `${label}: source change left stale height`);
              const renders = await page.evaluate(() => (window as any).lifecycle.stats().renders);
              await page.evaluate(() => {
                document.querySelector<HTMLElement>('.milkdown')!.style.setProperty('--wm-color-surface','#123456');
                (window as any).lifecycle.refresh();
              });
              await settled(page);
              check(await page.evaluate(() => (window as any).lifecycle.stats().renders) === renders+1, `${label}: theme did not invalidate cache`);
              if (scale === 1) {
                await page.evaluate(() => document.querySelector('.wm-document-scroll')!.scrollTop = 1800);
                await page.waitForSelector('.milkdown-code-block-placeholder', {state:'attached',timeout:8000});
                await page.evaluate(() => (window as any).lifecycle.setSource('flowchart LR\n A[Wide diagram] --> B[Second wide label] --> C[Third wide label] --> D[Fourth wide label]'));
                await settled(page);
                check(await page.locator('.wm-mermaid').textContent().then(text => text?.includes('Wide diagram')), `${label}: offscreen source was stale`);
                await page.waitForSelector('.milkdown-code-block-placeholder', {state:'attached',timeout:8000});
                await page.setViewportSize({width:650,height:900});
                await settled(page);
                const resized = await snapshot(page);
                await page.evaluate(() => document.querySelector('.wm-document-scroll')!.scrollTop = 0);
                await settled(page);
                check(Math.abs((await snapshot(page)).height-resized.height)<1, `${label}: offscreen resize left stale geometry`);
                const previousRenders = await page.evaluate(() => (window as any).lifecycle.stats().renders);
                await page.evaluate(() => {
                  document.querySelector<HTMLElement>('.milkdown')!.style.setProperty('--wm-font-code','serif');
                  (window as any).lifecycle.refresh();
                });
                await settled(page);
                check(await page.evaluate(() => (window as any).lifecycle.stats().renders) === previousRenders+1, `${label}: font change reused stale SVG`);
              }
              await page.evaluate(() => (window as any).lifecycle.setSource('not a diagram'));
              await page.waitForSelector('.wm-mermaid-error'); await settled(page);
              await page.evaluate(() => (window as any).lifecycle.setSource('ordinary text','txt'));
              await settled(page);
              check(await page.locator('.codemirror-host').isVisible(), `${label}: language change hid source`);
            }
            check(!errors.length, `${label}: browser errors: ${errors.join('; ')}`);
            console.log(`${label}: stable teardown/remount passed`);
          } finally { await page.close(); }
        }
      }));
    } finally { await browser.close(); }
  }
} finally { server.stop(true); await rm(outdir,{recursive:true,force:true}); }
