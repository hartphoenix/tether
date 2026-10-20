import { chromium, webkit } from 'playwright';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { controlRecentsLaunch } from '../src/server/lifecycle';
import { createWebBundleResponder } from '../src/web/bundle';

const scratch = await mkdtemp(join(tmpdir(), 'tether-appearance-'));
const config = resolveConfig({ profile: 'test', configDir: join(scratch, 'config'), runtimeDir: join(scratch, 'runtime') });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), opener: async () => {} });
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const original = '# Appearance\n\nA paragraph.\n';
try {
  await daemon.ready;
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    if (process.env.TETHER_CHECK_ENGINE && process.env.TETHER_CHECK_ENGINE !== name) continue;
    console.log(`${name}: starting appearance checks`);
    const browser = await type.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const reader = await context.newPage(), folio = await context.newPage();
      const errors: string[] = [];
      // WebKit reports requests cancelled during reload as access-control errors.
      reader.on('pageerror', error => { if (name === 'webkit' && /\/api\/draft due to access control checks/.test(error.message)) return; errors.push(error.message); }); folio.on('pageerror', error => errors.push(error.message));
      reader.setDefaultTimeout(12000); folio.setDefaultTimeout(12000);
      const path = join(scratch, `${name}.md`);
      await writeFile(path, original);
      const launch = daemon.mintTicket(await daemon.service.open(path));
      await reader.goto(launch.url);
      await reader.locator('.ProseMirror').waitFor();
      await folio.goto((await controlRecentsLaunch(config)).url);
      await folio.goto(new URL('settings', folio.url()).href);
      await folio.locator('#freshness').waitFor({ state: 'hidden' });
      const openSettings = async () => { await folio.locator('#settings-dialog').waitFor({ state: 'visible' }); };
      const scale = async (value: number) => folio.locator('#ui-scale').evaluate((el, value) => { (el as HTMLInputElement).value = String(value); el.dispatchEvent(new Event('input')); }, value);
      const bodySize = await reader.locator('.ProseMirror').evaluate(el => getComputedStyle(el).fontSize);
      await openSettings();
      const pinned = await folio.locator('#settings-dialog').evaluate(el => getComputedStyle(el).fontSize);
      await scale(150);
      await folio.screenshot({ path: join(tmpdir(), `tether-${name}-settings.png`) });
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1.5');
      check(await folio.locator('#settings-dialog').evaluate(el => getComputedStyle(el).fontSize) === pinned, 'settings resized during preview');
      check(await reader.locator('.milkdown-top-bar').evaluate(el => el.getBoundingClientRect().height) === 54, 'reader live preview');
      check(await reader.locator('.ProseMirror').evaluate(el => getComputedStyle(el).fontSize) === bodySize, 'interface scale changed document content');
      await folio.keyboard.press('Escape');
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1');
      await openSettings(); await scale(145);
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1.45');
      await folio.reload(); await folio.locator('#ui-scale').waitFor();
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1');
      await reader.locator('#comment').click();
      const resize = reader.getByRole('separator', { name: 'Threads width' });
      await resize.focus(); const resized = reader.waitForResponse(response => response.url().endsWith('api/preferences') && response.request().method() === 'PUT'); await reader.keyboard.press('ArrowLeft');
      await reader.waitForFunction(() => document.querySelector('.wm-rail-resizer')?.getAttribute('aria-valuenow') === '316');
      await resized;
      check(JSON.parse(await readFile(config.preferencesPath, 'utf8')).railWidth === 316, 'rail width persisted');
      await reader.reload(); await reader.locator('#comment').click();
      check(await reader.getByRole('separator', { name: 'Threads width' }).getAttribute('aria-valuenow') === '316', 'rail restored after reload');
      await reader.locator('#comment').click();
      await openSettings(); await scale(125); await folio.locator('#settings-save').click();
      await folio.waitForFunction(() => !(document.querySelector('#settings-save') as HTMLButtonElement).disabled);
      check(JSON.parse(await readFile(config.preferencesPath, 'utf8')).uiScale === 1.25, 'scale persisted');
      await reader.reload(); await reader.locator('.ProseMirror').waitFor();
      check(await reader.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale')) === '1.25', 'reader restored scale');
      await openSettings(); await scale(100); await folio.locator('#settings-save').click(); await folio.waitForFunction(() => !(document.querySelector('#settings-save') as HTMLButtonElement).disabled);
      // A crashed preview expires independently of any browser cleanup.
      await folio.evaluate(async () => { await fetch('api/preferences-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'crashed-test', uiScale: .7 }) }); });
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '0.7');
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1', undefined, { timeout: 20000 });
      console.log(`${name}: appearance and preview checks passed`);
      await reader.evaluate(async () => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ railWidth: 300 }) }); });
      check(errors.length === 0, errors.join('\n'));
      console.log(`PASS ${name}: live scale, cancel, persistence, expiry`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(scratch, { recursive: true, force: true }); }
