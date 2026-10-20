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
      for (const mode of ['revert-each', 'seen-each', 'margin-revert', 'revert-all', 'seen-then-revert-all', 'mixed-done', 'toggle-comment', 'changed-again']) {
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
        check(await reader.getByRole('button', { name: 'Mark all as seen', exact: true }).isVisible(), 'mark all label missing');
        check(await reader.locator('#save-review svg, #revert-review svg').count() === 2, 'bulk-action icons missing');
        if (mode === 'revert-each') {
          check(await reader.locator('#previous-change svg, #next-change svg').count() === 2, 'navigation icons missing');
          await reader.waitForFunction(() => {
            const bar = document.querySelector('#conflict')!.getBoundingClientRect();
            return Math.abs(document.querySelector('.wm-document-scroll')!.getBoundingClientRect().top - bar.top) < 1;
          });
          const glass = await reader.evaluate(() => {
            const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
            return [style('#conflict').backdropFilter, style('.milkdown-top-bar').backdropFilter];
          });
          check(glass[0] === 'blur(12px)' && glass[0] === glass[1], 'review glass differs from top bar');
          await reader.locator('#comment').click();
          await reader.waitForTimeout(250);
          const drawerLayout = await reader.evaluate(() => {
            const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            const bar = rect('#conflict'), rail = rect('.wm-annotation-rail'), editor = rect('#editor');
            return { top: rail.top, barTop: bar.top, edge: bar.right - rail.left, editorTop: editor.top - bar.bottom };
          });
          check(Object.values(drawerLayout).every(value => Math.abs(value) < 1), 'review bar overlaps full-height drawer: ' + JSON.stringify(drawerLayout));
          await reader.locator('#comment').click();
          await reader.waitForTimeout(250);
          check(await reader.locator('#conflict').evaluate(el => Math.abs(el.getBoundingClientRect().right - innerWidth) < 1), 'review bar does not expand after closing drawer');
          const metrics = await reader.evaluate(() => {
            const root = document.documentElement, bar = document.querySelector<HTMLElement>('#conflict')!;
            const button = document.querySelector<HTMLElement>('#save-review')!;
            const oldScale = root.style.getPropertyValue('--wm-ui-scale'), oldPrimary = root.style.getPropertyValue('--wm-color-primary');
            root.style.setProperty('--wm-ui-scale', '1');
            const normal = parseFloat(getComputedStyle(bar).fontSize);
            root.style.setProperty('--wm-ui-scale', '1.25');
            root.style.setProperty('--wm-color-primary', '#8844aa');
            const result = { normal, scaled: parseFloat(getComputedStyle(bar).fontSize), icon: document.querySelector('#previous-change svg')!.getBoundingClientRect().width, accent: getComputedStyle(button).color, border: getComputedStyle(button).borderTopWidth };
            if (oldScale) root.style.setProperty('--wm-ui-scale', oldScale); else root.style.removeProperty('--wm-ui-scale');
            if (oldPrimary) root.style.setProperty('--wm-color-primary', oldPrimary); else root.style.removeProperty('--wm-color-primary');
            return result;
          });
          check(metrics.normal === 14 && metrics.scaled === 17.5 && metrics.icon === 20, 'review interface scale mismatch: ' + JSON.stringify(metrics));
          check(metrics.accent === 'rgb(136, 68, 170)' && metrics.border === '0px', 'review controls ignore theme or retain boxes: ' + JSON.stringify(metrics));
        }
        if (mode === 'revert-all' || mode === 'seen-then-revert-all') {
          if (mode === 'seen-then-revert-all') {
            await hunkLine(0).click();
            await reader.waitForFunction(() => document.querySelectorAll('.tether-review-line').length === 2);
          }
          await reader.getByRole('button', { name: 'Revert all', exact: true }).click();
        } else if (mode === 'revert-each') {
          for (const theme of ['tether', 'tether-dark']) {
            await reader.evaluate(async theme => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) }); }, theme);
            await reader.waitForFunction(theme => document.documentElement.dataset.wmTheme === theme, theme);
            const colors = await reader.locator('#conflict').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, page: getComputedStyle(document.querySelector('.milkdown-top-bar')!).backgroundColor }));
            check(colors.background === colors.page, 'review surface differs from top bar: ' + JSON.stringify(colors));
            await reader.screenshot({ path: join(tmpdir(), `tether-${name}-${theme}-review.png`) });
          }
          for (const word of ['First', 'Second', 'Third']) {
            await rightClick('.tether-review-inserted', 'incoming');
            await reader.getByRole('menuitem', { name: 'Revert this change' }).click();
            await reader.waitForTimeout(word === 'Third' ? 0 : 100);
          }
        } else if (mode === 'margin-revert') {
          const line = hunkLine(0);
          check(await line.getAttribute('title') === 'Click to mark as seen', 'current wording margin tooltip');
          const seenCursor = await line.evaluate(el => getComputedStyle(el).cursor);
          check(seenCursor.includes('data:image/svg+xml'), 'seen cursor missing');
          await rightClick('.tether-review-inserted', 'incoming');
          await reader.getByRole('menuitem', { name: 'Show earlier wording', exact: true }).click();
          await reader.locator('.tether-review-line.is-before').waitFor();
          check(await line.getAttribute('title') === 'Click to revert change', 'earlier wording margin tooltip');
          const revertCursor = await line.evaluate(el => getComputedStyle(el).cursor);
          check(revertCursor.includes('data:image/svg+xml') && revertCursor !== seenCursor, 'revert cursor missing or identical');
          await line.click();
          await reader.waitForFunction(() => document.querySelector('#conflict-message')?.textContent === '2 changes to review');
          await reader.locator('#save-review').click();
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
          await rightClick('.tether-review-inserted', 'incoming');
          check(await reader.locator('.wm-menu-attribution').textContent() === 'Author unknown', 'neutral attribution heading missing');
          check(await reader.locator('.wm-context-menu [role="menuitem"]').count() === 4, 'heading entered action list');
          check(await reader.locator('.wm-context-menu').getAttribute('aria-description') === 'Edited by Author unknown', 'menu attribution description missing');
          check(await reader.evaluate(() => document.activeElement?.textContent) === 'Comment', 'header stole initial focus');
          await reader.keyboard.press('ArrowUp');
          check(await reader.evaluate(() => document.activeElement?.textContent) === 'Revert this change', 'keyboard navigation did not skip heading');
          await reader.getByRole('menuitem', { name: 'Comment', exact: true }).click();
          await reader.locator('.wm-annotation-textarea').last().fill('Keep the incoming wording.');
          await reader.locator('form:has(.wm-annotation-textarea) button[type="submit"]').last().click();
          await reader.locator('.wm-annotation-count').first().waitFor();
          // Let the preceding context-menu tap expire before starting a new pair.
          await reader.waitForTimeout(500);
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
          await reader.locator('.wm-thread-summary').last().click();
          await reader.locator('.wm-thread-before', { hasText: 'original' }).first().waitFor();
          await reader.locator('#comment').click();
          const badge = reader.locator('.wm-annotation-count').first();
          await reader.waitForFunction(() => document.querySelector('.wm-annotation-count')?.textContent === '2');
          await badge.click();
          const conversation = reader.locator('.wm-thread-popover');
          await conversation.getByText('Keep the incoming wording.', { exact: true }).waitFor();
          await conversation.getByText('Why drop the original?', { exact: true }).waitFor();
          check(await conversation.locator('.wm-thread-wording').allTextContents().then(labels => labels.join(',') === 'Current wording,Earlier wording'), 'wording labels missing');
          const forms = conversation.locator('.wm-annotation-reply-form');
          check(await forms.count() === 1, 'conversation must have one reply form');
          check(await forms.evaluate(el => el === el.parentElement?.lastElementChild), 'reply form must be at the bottom');
          check(await conversation.locator('.wm-thread-before').textContent() === 'original', 'earlier comment quotes current wording');
          await forms.locator('textarea').fill('Reply to the whole conversation');
          await forms.locator('button[type="submit"]').click();
          await conversation.getByText('Reply to the whole conversation', { exact: true }).waitFor();
          check(await badge.textContent() === '3', 'badge did not include grouped reply');
          check(await forms.evaluate(el => el.previousElementSibling?.textContent?.includes('Reply to the whole conversation')), 'new reply must follow both original comments');
          await forms.locator('textarea').fill('Keep this draft');
          await reader.evaluate(() => dispatchEvent(new Event('online')));
          await reader.waitForTimeout(700);
          check(await forms.locator('textarea').inputValue() === 'Keep this draft', 'conversation draft lost');
          await conversation.getByRole('button', { name: 'Close comment', exact: true }).click();
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
        if (mode === 'revert-all') check(saved.includes('First original') && saved.includes('Second original') && saved.includes('Third original') && !saved.includes('incoming'), 'Revert all did not restore the baseline');
        if (mode === 'seen-then-revert-all') check(saved.includes('First incoming') && saved.includes('Second original') && saved.includes('Third original'), 'Revert all did not preserve the seen hunk');
        if (mode === 'mixed-done' || mode === 'margin-revert') check(saved.includes('First original') && saved.includes('Second incoming') && saved.includes('Third incoming'), 'Done lost a revert');
        if (mode === 'toggle-comment') check(saved === incoming, 'Done wrote the file');
        if (mode === 'changed-again') check(saved === '# Changed again\n', 'a later disk change was overwritten');
      }
      check(errors.length === 0, errors.join('\n'));
      console.log(`PASS ${name}: hunk reverts, seen lines, Done, earlier wording, review comments, mid-review changes`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(scratch, { recursive: true, force: true }); }
