import { chromium, webkit } from 'playwright';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';

// Incoming-change review in a real browser: hunks, margin lines, the earlier-wording toggle, review comments and Done.
const scratch = await mkdtemp(join(tmpdir(), 'tether-review-'));
const config = resolveConfig({ profile: 'test', configDir: join(scratch, 'config'), runtimeDir: join(scratch, 'runtime') });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), opener: async () => {} });
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const original = '# Review\n\nFirst original paragraph.\n\nUnchanged separator.\n\nSecond original paragraph.\n\nAnother separator.\n\nThird original paragraph.\n';
const incoming = original.replaceAll('original', 'incoming');
try {
  await daemon.ready;
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    if (process.env.TETHER_CHECK_ENGINE && process.env.TETHER_CHECK_ENGINE !== name) continue;
    const browser = await type.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const reader = await context.newPage();
      const errors: string[] = [];
      reader.on('pageerror', error => { if (name === 'webkit' && /\/api\/draft due to access control checks/.test(error.message)) return; errors.push(error.message); });
      reader.setDefaultTimeout(12000);
      const path = join(scratch, `${name}.md`);
      await writeFile(path, original);
      await reader.goto(daemon.mintTicket(await daemon.service.open(path)).url);
      await reader.locator('.ProseMirror').waitFor();
      const hunkLine = (index: number) => reader.locator('.tether-review-line').nth(index);
      const rightClick = async (selector: string, text: string) => {
        const box = (await reader.locator(selector, { hasText: text }).first().boundingBox())!;
        await reader.mouse.click(box.x + 4, box.y + box.height / 2, { button: 'right' });
      };
      for (const mode of ['revert-each', 'seen-each', 'mixed-done', 'toggle-comment', 'changed-again']) {
        console.log(`${name}: review ${mode}`);
        await writeFile(path, original); await reader.reload(); await reader.locator('.ProseMirror').waitFor();
        await reader.waitForTimeout(150);
        await writeFile(path, incoming);
        await reader.evaluate(() => dispatchEvent(new Event('online')));
        await reader.locator('#save-review').waitFor({ state: 'visible' });
        check(await reader.locator('#conflict-message').textContent() === '3 changes to review', 'review banner wording');
        check(!await reader.locator('#reload').isVisible(), 'reload visible in review');
        check(await reader.locator('.ProseMirror').textContent().then(text => text!.includes('First incoming') && !text!.includes('original')), 'review does not show the disk version');
        check(await reader.locator('.tether-review-inserted', { hasText: 'incoming' }).count() === 3, 'inserted words not marked');
        check(await reader.locator('.tether-review-line').count() === 3, 'margin lines missing');
        check(await readFile(path, 'utf8') === incoming, 'starting review wrote the file');
        if (mode === 'revert-each') {
          for (const theme of ['tether', 'tether-dark']) {
            await reader.evaluate(async theme => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) }); }, theme);
            await reader.waitForFunction(theme => document.documentElement.dataset.wmTheme === theme, theme);
            const colors = await reader.locator('#conflict').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, page: getComputedStyle(document.querySelector('.milkdown-top-bar')!).backgroundColor }));
            check(colors.background !== 'rgb(56, 47, 30)', 'review banner kept conflict colors');
            await reader.screenshot({ path: join(tmpdir(), `tether-${name}-${theme}-review.png`) });
          }
          for (const word of ['First', 'Second', 'Third']) {
            await rightClick('.tether-review-inserted', 'incoming');
            await reader.getByRole('menuitem', { name: 'Revert this change' }).click();
            await reader.waitForTimeout(word === 'Third' ? 0 : 100);
          }
        } else if (mode === 'seen-each') {
          for (const remaining of [2, 1, 0]) {
            await hunkLine(0).click();
            await reader.waitForFunction(remaining => document.querySelectorAll('.tether-review-line').length === remaining, remaining);
          }
        } else if (mode === 'mixed-done') {
          await rightClick('.tether-review-inserted', 'incoming');
          await reader.getByRole('menuitem', { name: 'Revert this change' }).click();
          await reader.waitForFunction(() => document.querySelector('#conflict-message')?.textContent === '2 changes to review');
          await reader.locator('#save-review').click();
        } else if (mode === 'toggle-comment') {
          // Two quick secondary clicks show the earlier wording in place.
          const box = (await reader.locator('.tether-review-inserted', { hasText: 'incoming' }).first().boundingBox())!;
          await reader.mouse.click(box.x + 4, box.y + box.height / 2, { button: 'right' });
          await reader.mouse.click(box.x + 6, box.y + box.height / 2, { button: 'right' });
          await reader.locator('.tether-review-before', { hasText: 'original' }).waitFor();
          check(await reader.locator('.tether-review-ghost', { hasText: 'original' }).count() === 1, 'removed words not ghosted');
          check(!await reader.locator('.wm-context-menu').isVisible(), 'menu stayed open after the double tap');
          await reader.locator('.tether-review-line.is-before').waitFor();
          await reader.screenshot({ path: join(tmpdir(), `tether-${name}-review-before.png`) });
          await rightClick('.tether-review-before', 'original');
          await reader.getByRole('menuitem', { name: 'Comment' }).click();
          const composer = reader.locator('.wm-annotation-textarea').last();
          await composer.fill('Why drop the original?');
          await reader.locator('form:has(.wm-annotation-textarea) button[type="submit"]').last().click();
          await reader.locator('#comment').click();
          await reader.waitForFunction(() => {
            const w = window as any;
            if (!w.__reviewThread) w.__reviewThread = fetch('api/annotations?actor=human').then(r => r.json()).then(state => { w.__reviewThreadDone = state.annotations?.threads?.some((thread: any) => thread.comment.anchor?.before?.exact === 'original' && thread.comment.anchor.exact.includes('incoming')); w.__reviewThread = null; });
            return w.__reviewThreadDone === true;
          });
          await reader.locator('.wm-thread-summary').first().click();
          await reader.locator('.wm-thread-before', { hasText: 'original' }).first().waitFor();
          check(await readFile(path, 'utf8') === incoming, 'commenting during review wrote the file');
          await reader.locator('#save-review').click();
        } else {
          await writeFile(path, '# Changed again\n');
          await reader.evaluate(() => dispatchEvent(new Event('online')));
          await reader.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Changed again'));
          await reader.locator('#save-review').click();
        }
        await reader.locator('#conflict').waitFor({ state: 'hidden' });
        await reader.waitForTimeout(900);
        const saved = await readFile(path, 'utf8');
        check(!await reader.locator('.tether-review-line, .tether-review-inserted').count(), 'review styling remained after review ended');
        if (mode === 'revert-each') check(!saved.includes('incoming') && saved.includes('Third original'), 'reverts did not save: ' + JSON.stringify(saved) + ' notice: ' + await reader.locator('#notice').textContent());
        if (mode === 'seen-each') check(saved === incoming, 'marking changes seen wrote the file');
        if (mode === 'mixed-done') check(saved.includes('First original') && saved.includes('Second incoming') && saved.includes('Third incoming'), 'Done lost a revert');
        if (mode === 'toggle-comment') check(saved === incoming, 'Done wrote the file');
        if (mode === 'changed-again') check(saved === '# Changed again\n', 'a later disk change was overwritten');
      }
      check(errors.length === 0, errors.join('\n'));
      console.log(`PASS ${name}: hunk reverts, seen lines, Done, earlier wording, review comments, mid-review changes`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(scratch, { recursive: true, force: true }); }
