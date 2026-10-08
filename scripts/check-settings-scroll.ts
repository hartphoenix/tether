import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { folioHtml, folioTheme } from '../src/web/folio-page';

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/settings') return new Response(folioHtml({ settingsOnly: true, apiBase: '/api' }), { headers: { 'Content-Type': 'text/html' } });
  if (path === '/api/snapshot') return Response.json({ sequence: 1, files: [], retention: { mode: 'days', days: 30 }, preferences: folioTheme() });
  if (path === '/api/fly/status') return Response.json({ configured: true, enabled: true, origin: 'https://hub.example', machines: [{ id: 'local', name: 'Test machine', connected: true }], clients: [], attempts: [] });
  return Response.json({});
} });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [960, 375]) {
        const page = await browser.newPage({ viewport: { width, height: 600 } });
        const waitForScroll = async (label: string, condition: () => boolean) => {
          try { await page.waitForFunction(condition, {}, { timeout: 2000 }); }
          catch (cause) { throw new Error(`${engine.name()} ${width}px ${label}: ${JSON.stringify(await page.evaluate(() => ({ y: scrollY, height: innerHeight, document: document.documentElement.scrollHeight, body: document.body.scrollHeight, bodyHeight: document.body.clientHeight, overflow: getComputedStyle(document.body).overflow })))}`, { cause }); }
        };
        for (const expanded of [false, true]) {
          await page.goto(new URL('/settings', server.url).href);
          await page.getByText('Connections enabled').waitFor();
          if (expanded) await page.locator('#fly-settings details').evaluateAll(groups => groups.forEach(group => (group as HTMLDetailsElement).open = true));
          await page.evaluate(() => window.scrollTo(0, 0));
          // Actual wheel input over Settings must reach the page scroller. Locator
          // clicks and scrollIntoView bypass scroll chaining and missed this bug.
          await page.mouse.move(width / 2, 100);
          await page.mouse.wheel(0, 600);
          await waitForScroll('wheel down', () => window.scrollY > 100);
          await page.mouse.wheel(0, 10000);
          await waitForScroll('wheel to bottom', () => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2);
          if (expanded) {
            const bounds = await page.getByRole('button', { name: 'Disable Tether Fly…' }).boundingBox();
            assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 600, 'Bottom Settings control must be inside the viewport');
          }
          await page.mouse.wheel(0, -10000);
          await waitForScroll('wheel up', () => window.scrollY === 0);
          await page.locator('#settings-title').click();
          await page.keyboard.press('PageDown');
          await waitForScroll('PageDown', () => window.scrollY > 100);
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Settings scrolling passed: wheel down/up, bottom reachability, and PageDown in Chromium and WebKit at desktop and narrow widths.');
} finally { server.stop(); }
