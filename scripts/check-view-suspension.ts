import { chromium, webkit, type Page } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
import { runCli } from '../src/cli/main';

const root = await mkdtemp(join(tmpdir(), 'tether-suspension-'));
const config = resolveConfig({ profile: 'suspension-test', configDir: join(root, 'config'), runtimeDir: join(root, 'runtime') });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), opener: async () => {} });
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const hostState = (page: Page, visible: boolean, folioRevision?: string) => page.evaluate(state => {
  (window as any).__tetherHostState = state;
  dispatchEvent(new Event('tether-host-state'));
}, { visible, folioRevision });
try {
  await daemon.ready;
  const path = join(root, 'document.md');
  await writeFile(path, '# Suspension\n\n' + Array.from({ length: 70 }, (_, i) => `Paragraph ${i}: reading position and retained state.\n\n`).join(''));
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const requests: string[] = [];
      page.on('request', request => { const endpoint = new URL(request.url()).pathname.split('/api/')[1]; if (endpoint) requests.push(endpoint); });
      await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
      await page.locator('.ProseMirror').waitFor();
      await page.waitForFunction(() => !document.querySelector('#editor')?.hasAttribute('inert'));
      await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop = 1500; });
      await page.waitForTimeout(2200);
      const initialScroll = await page.locator('.wm-document-scroll').evaluate(el => el.scrollTop);
      const draftWrites = requests.filter(x => x === 'draft').length;
      await page.waitForTimeout(3200);
      check(requests.filter(x => x === 'draft').length === draftWrites, `${name}: unchanged reader kept writing drafts`);
      await hostState(page, false);
      await page.waitForTimeout(400);
      const hiddenStart = requests.length;
      await page.waitForTimeout(8000);
      check(requests.length === hiddenStart, `${name}: hidden reader made requests: ${requests.slice(hiddenStart)}`);
      const started = Date.now();
      await hostState(page, true);
      await page.waitForFunction(scroll => document.querySelector('.wm-document-scroll')?.scrollTop === scroll, initialScroll);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const resumeMs = Date.now() - started;
      await page.waitForTimeout(300);
      check(requests.slice(hiddenStart).some(x => x.startsWith('changes')), `${name}: reader did not revalidate on return`);
      console.log(`${name}: reader quiet while hidden; unchanged drafts deduplicated; retained scroll=${initialScroll}; warm visible check=${resumeMs}ms`);
      await page.close();

      const result = await runCli(['folio', '--url', '--host', 'browser'], { config });
      if (!result.response.ok) throw Error('Folio launch failed: ' + JSON.stringify(result.response));
      const launch = result.response.data as { url: string };
      const folio = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      const counts = { snapshot: 0, presence: 0 };
      folio.on('request', request => { const endpoint = new URL(request.url()).pathname.split('/api/')[1]; if (endpoint === 'snapshot' || endpoint === 'presence') counts[endpoint]++; });
      await folio.goto(launch.url);
      await folio.locator('#filter').waitFor();
      await hostState(folio, true, '1');
      await folio.waitForTimeout(300);
      await folio.locator('#filter').fill('preserve this filter');
      const snapshots = counts.snapshot;
      await folio.waitForTimeout(2400);
      check(counts.snapshot === snapshots, `${name}: managed idle Folio kept polling snapshots`);
      await folio.clock.install();
      await hostState(folio, false, '2');
      await folio.waitForTimeout(200);
      const hiddenCounts = { ...counts };
      await folio.clock.fastForward(30100);
      await folio.waitForTimeout(100);
      check(JSON.stringify(counts) === JSON.stringify(hiddenCounts), `${name}: hidden Folio requested state`);
      await hostState(folio, true, '3');
      await folio.waitForTimeout(300);
      check(counts.snapshot === snapshots + 1, `${name}: Folio failed to catch up once`);
      check(await folio.locator('#filter').inputValue() === 'preserve this filter', `${name}: filter lost on return`);
      // Advance the page timer to check that idle maintenance uses only the cheap lease route.
      await hostState(folio, false, '3'); await hostState(folio, true, '3');
      await folio.waitForTimeout(100);
      const beforeLease = counts.snapshot;
      await folio.clock.fastForward(30_100);
      await folio.waitForTimeout(100);
      check(counts.snapshot === beforeLease && counts.presence > 0, `${name}: idle maintenance rebuilt the library`);
      console.log(`${name}: Folio idle/hidden requests bounded; return retained filters; maintenance renews presence only`);
      await folio.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(root, { recursive: true, force: true }); }
