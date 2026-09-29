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
const original = '# Review\n\nFirst original paragraph.\n\nUnchanged separator.\n\nSecond original paragraph.\n\nAnother separator.\n\nThird original paragraph.\n';
const incoming = original.replaceAll('original', 'incoming');
try {
  await daemon.ready;
  for (const [name, type] of Object.entries({ chromium, webkit })) {
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
      await folio.locator('#freshness').waitFor({ state: 'hidden' });
      const openSettings = async () => { await folio.locator('#more').click(); await folio.locator('[data-app-action="settings"]').click(); };
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
      await folio.reload(); await folio.locator('#more').waitFor();
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1');
      await reader.locator('#comment').click();
      const resize = reader.getByRole('separator', { name: 'Threads width' });
      await resize.focus(); const resized = reader.waitForResponse(response => response.url().endsWith('api/preferences') && response.request().method() === 'PUT'); await reader.keyboard.press('ArrowLeft');
      await reader.waitForFunction(() => document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow') === '316');
      await resized;
      check(JSON.parse(await readFile(config.preferencesPath, 'utf8')).railWidth === 316, 'rail width persisted');
      await reader.reload(); await reader.locator('#comment').click();
      check(await reader.getByRole('separator', { name: 'Threads width' }).getAttribute('aria-valuenow') === '316', 'rail restored after reload');
      await reader.locator('#comment').click();
      await openSettings(); await scale(125); await folio.locator('#settings-save').click();
      await folio.locator('#settings-dialog').waitFor({ state: 'hidden' });
      check(JSON.parse(await readFile(config.preferencesPath, 'utf8')).uiScale === 1.25, 'scale persisted');
      await reader.reload(); await reader.locator('.ProseMirror').waitFor();
      check(await reader.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale')) === '1.25', 'reader restored scale');
      await openSettings(); await folio.locator('#scale-reset').click(); await folio.locator('#settings-save').click(); await folio.locator('#settings-dialog').waitFor({ state: 'hidden' });
      // A crashed preview expires independently of any browser cleanup.
      await folio.evaluate(async () => { await fetch('api/preferences-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'crashed-test', uiScale: .7 }) }); });
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '0.7');
      await reader.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale') === '1', undefined, { timeout: 20000 });
      for (const mode of ['per-change', 'per-accept', 'accept-all', 'reject-all', 'conflict']) {
        await writeFile(path, original); await reader.reload(); await reader.locator('.ProseMirror').waitFor();
        await reader.waitForTimeout(150);
        await writeFile(path, incoming);
        await reader.evaluate(() => dispatchEvent(new Event('online')));
        await reader.locator('#save-review').waitFor({ state: 'visible' });
        check(await reader.locator('#conflict-message').textContent() === 'There are new changes for your review.', 'review banner wording');
        check(!await reader.locator('#reload').isVisible(), 'reload visible in review');
        if (mode === 'per-change') {
          for (const theme of ['tether', 'tether-dark']) {
            await reader.evaluate(async theme => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) }); }, theme);
            await reader.waitForFunction(theme => document.documentElement.dataset.wmTheme === theme, theme);
            const colors = await reader.locator('#conflict').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
            check(colors.background.includes('color') || colors.background.includes('rgb'), 'banner theme missing');
            await reader.screenshot({ path: join(tmpdir(), `tether-${name}-${theme}-banner.png`) });
          }
        }
        if (mode === 'per-change') {
          while (await reader.getByRole('button', { name: 'Reject', exact: true }).count()) await reader.getByRole('button', { name: 'Reject', exact: true }).first().click();
        } else if (mode === 'per-accept') {
          while (await reader.getByRole('button', { name: 'Accept', exact: true }).count()) await reader.getByRole('button', { name: 'Accept', exact: true }).first().click();
        } else if (mode === 'accept-all') {
          await reader.getByRole('button', { name: 'Reject', exact: true }).first().click();
          await reader.locator('#save-review').click();
        } else if (mode === 'reject-all') {
          await reader.getByRole('button', { name: 'Accept', exact: true }).first().click();
          await reader.locator('#cancel-review').click();
        } else {
          await writeFile(path, '# Changed again\n');
          await reader.locator('#save-review').click();
          await reader.locator('#reload').waitFor({ state: 'visible' });
          check((await reader.locator('#conflict-message').textContent())?.includes('changed again'), 'save conflict missing');
          check(await readFile(path, 'utf8') === '# Changed again\n', 'conflicting write overwritten');
          continue;
        }
        await reader.locator('#conflict').waitFor({ state: 'hidden' });
        const saved = await readFile(path, 'utf8');
        if (mode === 'per-accept') check(!saved.includes('original'), 'last acceptance did not save');
        if (mode === 'per-change') check(!saved.includes('incoming'), 'last rejection did not save');
        if (mode === 'accept-all') check(saved.includes('First original') && saved.includes('Second incoming') && saved.includes('Third incoming'), 'Accept All lost previous rejection');
        if (mode === 'reject-all') check(saved.includes('First incoming') && saved.includes('Second original') && saved.includes('Third original'), 'Reject All lost previous acceptance');
      }
      await reader.evaluate(async () => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ railWidth: 300 }) }); });
      check(errors.length === 0, errors.join('\n'));
      console.log(`PASS ${name}: live scale, cancel, persistence, expiry, per-change autosave, mixed bulk decisions, save conflicts`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(scratch, { recursive: true, force: true }); }
