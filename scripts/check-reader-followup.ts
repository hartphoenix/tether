import { chromium, webkit } from 'playwright';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
import { PaseoHostAdapter } from '../src/hosts/paseo';
import { controlRecentsLaunch } from '../src/server/lifecycle';

const scratch = await mkdtemp(join(tmpdir(), 'tether-followup-'));
const config = resolveConfig({ profile: 'test', configDir: join(scratch, 'config'), runtimeDir: join(scratch, 'runtime') });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), hostAdapter: new PaseoHostAdapter({ enqueue: async () => {} }), opener: async () => {} });
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function checkFullscreenShortcut(page: import('playwright').Page) {
  const result = await page.evaluate(() => {
    let reachedWindow = false;
    const listener = () => { reachedWindow = true; };
    window.addEventListener('keydown', listener);
    const event = new KeyboardEvent('keydown', { key: 'F', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    window.removeEventListener('keydown', listener);
    return { reachedWindow, prevented: event.defaultPrevented };
  });
  check(result.reachedWindow && !result.prevented, 'Command+Shift+F was intercepted by Find');
}
const original = '# Followup\n\n' + Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${i === 2 || i === 20 ? 'needle' : 'ordinary'} words for review.`).join('\n\n') + '\n\n```txt\n' + Array.from({ length: 150 }, (_, i) => i === 120 ? 'offscreen needle' : `line ${i}`).join('\n') + '\n```\n';
try {
  await daemon.ready;
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv[2] && process.argv[2] !== name) continue;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      const errors: string[] = []; page.on('pageerror', error => {
        // WebKit reports the in-flight draft request cancelled by reload this way.
        if (name === 'webkit' && /\/api\/draft due to access control checks/.test(error.message)) return;
        errors.push(error.message);
      });
      const path = join(scratch, `${name}.md`); await writeFile(path, original);
      await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
      await page.locator('.ProseMirror').waitFor();
      await checkFullscreenShortcut(page);
      check(await page.locator('.wm-find').isHidden(), 'Fullscreen shortcut opened Find');
      await page.keyboard.press('Meta+f');
      await checkFullscreenShortcut(page);
      const input = page.getByRole('searchbox', { name: 'Find on page' });
      await input.fill('needle');
      await page.waitForFunction(() => document.querySelector('.wm-find output')?.textContent === '1 / 3');
      await input.press('Enter'); await input.press('Enter'); await page.waitForTimeout(150);
      check(await page.locator('.wm-find output').textContent() === '3 / 3', 'Find did not navigate to virtualized code');
      check(await page.evaluate(() => CSS.highlights.get('tether-find-current')?.size === 1), 'Find did not paint current match');
      await input.press('Enter'); check(await page.locator('.wm-find output').textContent() === '1 / 3', 'Find wrap');
      await input.fill('unmatched'); check(await page.locator('.wm-find output').textContent() === 'No results', 'Find no results');
      await input.press('Escape'); check(await page.locator('.wm-find').isHidden(), 'Escape did not close Find');
      check(await readFile(path, 'utf8') === original, 'Find changed Markdown');
      // Real annotation updates exercise keyed cards and draft survival.
      await page.evaluate(async () => {
        const file = await (await fetch('api/file')).json();
        for (let i = 0; i < 4; i++) {
          const response = await fetch('api/annotations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'comment', actor: i % 2 ? 'assistant' : 'human', body: `Thread ${i}\n\n` + 'A long reply body. '.repeat(i === 1 ? 70 : 3), expectedBodyRevision: file.bodyRevision, anchor: { exact: `Paragraph ${i}`, prefix: '', suffix: ':', projectionStart: 0, projectionEnd: `Paragraph ${i}`.length, bodyRevision: file.bodyRevision } }) });
          if (!response.ok) throw new Error(await response.text());
        }
      });
      await page.reload(); await page.locator('.ProseMirror').waitFor();
      await page.locator('#comment').click();
      await page.locator('.wm-thread-summary').nth(3).waitFor().catch(async error => { console.log(await page.evaluate(() => ({cards:document.querySelectorAll('.wm-thread-summary').length,rail:document.querySelector('.wm-annotation-rail')?.outerHTML.slice(0,400),notice:document.querySelector('#notice')?.textContent})),errors); throw error; }); await page.waitForTimeout(250);
      const summaries = page.locator('.wm-thread-summary');
      for (const i of [0, 1, 3]) {
        await summaries.nth(i).click(); await page.waitForTimeout(260);
        const bounds = await summaries.nth(i).evaluate(el => ({ card: el.parentElement!.getBoundingClientRect().top, header: document.querySelector('.wm-annotation-rail-header')!.getBoundingClientRect().bottom }));
        check(Math.abs(bounds.card - bounds.header - 12) < 2, `${name}: thread ${i} failed to align: ${JSON.stringify(bounds)}`);
        const top = bounds.card;
        await summaries.nth(i).click(); await page.waitForTimeout(260);
        check(Math.abs((await summaries.nth(i).evaluate(el => el.parentElement!.getBoundingClientRect().top)) - top) < 2, 'collapse moved clicked card');
      }
      await summaries.nth(1).click(); await page.waitForTimeout(250);
      const reply = page.locator('.wm-thread-card').nth(1).locator('.wm-annotation-reply-form textarea');
      await reply.fill('Unsent draft');
      await summaries.nth(1).dispatchEvent('click'); await page.waitForTimeout(60);
      await summaries.nth(1).dispatchEvent('click'); await page.waitForTimeout(250);
      check(await reply.inputValue() === 'Unsent draft', 'toggle lost draft');
      await reply.focus();
      await page.evaluate(async () => {
        const threadId = document.querySelectorAll<HTMLElement>('.wm-thread-card')[1]!.dataset.threadId;
        await fetch('api/annotations/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, actor: 'assistant', body: 'Incoming reply during drafting' }) });
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await page.locator('.wm-thread-body').getByText('Incoming reply during drafting', { exact: true }).waitFor({ timeout: 35000 });
      check(await reply.inputValue() === 'Unsent draft', 'incoming reply lost draft');
      check(await reply.evaluate(el => el === document.activeElement), 'incoming reply lost focus');
      await page.locator('.wm-thread-card').nth(1).getByRole('button', { name: 'Reply', exact: true }).click();
      await page.waitForFunction(() => (document.querySelectorAll('.wm-thread-card')[1]?.querySelector('textarea') as HTMLTextAreaElement)?.value === '');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await summaries.nth(3).click();
      check(await summaries.nth(3).getAttribute('aria-expanded') === 'true', 'reduced-motion expansion');
      await page.locator('#comment').click(); check(await page.locator('.wm-annotation-rail').isHidden(), 'reduced-motion drawer close');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('#theme').click();
      check(await page.locator('#theme-menu').isVisible(), 'theme menu did not open'); await page.keyboard.press('Escape');
      const incoming = original.replace('Paragraph 10: ordinary', 'Paragraph 10: incoming').replace('Paragraph 30: ordinary', 'Paragraph 30: incoming');
      await writeFile(path, incoming); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('#next-change').waitFor({timeout:35000});
      await page.locator('#next-change').click(); await page.waitForTimeout(250);
      const first = await page.locator('.wm-document-scroll').evaluate(el => el.scrollTop);
      let second = first;
      for (let i = 0; i < 12 && Math.abs(second - first) < 100; i++) {
        await page.locator('#next-change').click(); await page.waitForTimeout(250);
        second = await page.locator('.wm-document-scroll').evaluate(el => el.scrollTop);
      }
      check(Math.abs(second - first) > 100, `Next change did not advance: ${first}, ${second}; ${errors.join('; ')}`);
      await page.locator('#previous-change').click(); await page.waitForTimeout(250);
      check(Math.abs((await page.locator('.wm-document-scroll').evaluate(el => el.scrollTop)) - first) < 2, 'Previous did not return');
      check(await readFile(path, 'utf8') === incoming, 'navigation wrote the document');
      await page.locator('#save-review').click(); await page.locator('#conflict').waitFor({ state: 'hidden' });
      const folio = await context.newPage(); folio.on('pageerror', error => errors.push(error.message));
      await folio.goto((await controlRecentsLaunch(config)).url); await folio.locator('.file').first().waitFor();
      await checkFullscreenShortcut(folio);
      check(await folio.locator('.wm-find').isHidden(), 'Fullscreen shortcut opened Folio Find');
      await folio.keyboard.press('Meta+f');
      await checkFullscreenShortcut(folio); await folio.getByRole('searchbox', { name: 'Find on page' }).fill(name);
      check((await folio.locator('.wm-find output').textContent())?.includes('/'), 'Folio Find');
      check(errors.length === 0, errors.join('\n'));
      console.log(`PASS ${name}: Find, virtual code, thread anchoring/drafts, reduced motion, menus, review navigation`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(scratch, { recursive: true, force: true }); }
