import { chromium, webkit, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outdir = await mkdtemp(join(tmpdir(), 'tether-geometry-'));
const build = await Bun.build({ entrypoints: ['./tests/browser/geometry-fixture.ts'], outdir, target: 'browser' });
if (!build.success) throw new Error('Geometry fixture build failed');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('<link rel="stylesheet" href="/geometry-fixture.css"><div id="workspace"><main id="editor"></main><div id="annotations"></div></div><script type="module" src="/geometry-fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/image.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="steelblue"/></svg>', {headers:{'Content-Type':'image/svg+xml'}});
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (!build.outputs.some(output => '/' + output.path.split('/').pop() === path)) return new Response(null, { status: 404 });
  return new Response(Bun.file(join(outdir, path.slice(1))));
}});
const endpointsPath = process.env.TETHER_TEST_BROWSER_ENDPOINTS;
const endpoints = endpointsPath ? await Bun.file(endpointsPath).json() as Record<string, string> : null;
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function topology(page: Page, scale: number) {
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).ready);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(z => (window as any).audit.setZoom(z), scale);
  await page.waitForTimeout(150);
  const originalMarkdown = await page.evaluate(() => (window as any).audit.crepe.getMarkdown());
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.wm-canvas-stage')!;
    const scene = document.querySelector<HTMLElement>('.wm-canvas-scene')!;
    const scroller = document.querySelector<HTMLElement>('.wm-document-scroll')!;
    const header = document.querySelector<HTMLElement>('.milkdown-top-bar')!;
    return { stage: stage.getBoundingClientRect().height, scene: scene.getBoundingClientRect().height,
      scrollTop: scroller.getBoundingClientRect().top, headerTop: header.getBoundingClientRect().top,
      scrollPadding: parseFloat(getComputedStyle(scroller).paddingTop), headerHeight: header.offsetHeight,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
      scrollHeight: document.querySelector('.wm-document-scroll')!.scrollHeight, bottom: stage.offsetHeight + parseFloat(getComputedStyle(document.querySelector('.wm-document-scroll')!).paddingTop),
      clip: getComputedStyle(stage).overflow, parent: (window as any).audit.view.dom.offsetParent === scene };
  });
  check(Math.abs(geometry.scrollTop - geometry.headerTop) <= 1 && Math.abs(geometry.scrollPadding - geometry.headerHeight) <= 1, `reader does not extend behind glass header: ${JSON.stringify(geometry)}`);
  check(Math.abs(geometry.stage - geometry.scene) <= 1.1, `stage height mismatch at ${scale}`);
  check(geometry.pageWidth <= geometry.viewportWidth + 1, `horizontal overflow at ${scale}`);
  check(geometry.pageHeight <= geometry.viewportHeight + 2 && geometry.scrollHeight <= Math.max(geometry.viewportHeight, geometry.bottom) + 2, `phantom document extent at ${scale}: ${JSON.stringify(geometry)}`);
  check(geometry.clip === 'clip' && geometry.parent, 'incorrect clipping/offset parent');
  await page.locator('.ProseMirror p').nth(5).click();
  await page.waitForTimeout(100);
  const caret = await page.evaluate(() => {
    const view = (window as any).audit.view;
    return { focus: view.hasFocus(), text: view.state.selection.$from.parent.textContent, native: document.getSelection()?.anchorNode?.textContent };
  });
  check(caret.focus && caret.text.startsWith('Paragraph 5:'), `native caret hit test at ${scale}: ${JSON.stringify(caret)}`);
  const paragraph = await page.locator('.ProseMirror p').nth(5).boundingBox();
  check(paragraph, 'paragraph missing');
  await page.mouse.move(paragraph.x + 4, paragraph.y + 8 * scale);
  await page.mouse.down();
  await page.mouse.move(paragraph.x + 100 * scale, paragraph.y + 8 * scale, { steps: 8 });
  await page.mouse.up();
  check(await page.evaluate(() => !(window as any).audit.view.state.selection.empty), `native range selection at ${scale}`);
  await page.locator('.ProseMirror p').nth(5).click();
  await page.locator('.ProseMirror a').nth(8).evaluate(el => el.scrollIntoView({block:'center'}));
  await page.locator('.ProseMirror a').nth(8).hover();
  await page.waitForTimeout(150);
  const popupParent = await page.locator('.milkdown-link-preview').evaluate(el => el.parentElement?.classList.contains('milkdown'));
  check(popupParent, 'free popup did not escape clipped scene');
  const preview = page.locator('.milkdown-link-preview');
  check(await preview.getAttribute('data-show') === 'true', 'real link hover did not show preview');
  const popupBox = await preview.boundingBox();
  check(popupBox && popupBox.x >= -1 && popupBox.x + popupBox.width <= 1201 && popupBox.y >= 0 && popupBox.y + popupBox.height <= 801, 'preview outside viewport');
  check(await preview.textContent().then(text => text?.includes('https://example.com/8')), 'wrong hovered link identity');
  const linkBefore = await page.locator('.ProseMirror a').nth(8).boundingBox();
  const previewBefore = await preview.boundingBox();
  await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop += 60; });
  await page.waitForTimeout(120);
  const linkAfter = await page.locator('.ProseMirror a').nth(8).boundingBox();
  const previewAfter = await preview.boundingBox();
  check(linkBefore && linkAfter && previewBefore && previewAfter, 'preview disappeared on ordinary scroll');
  check(Math.abs((linkAfter.y-linkBefore.y)-(previewAfter.y-previewBefore.y)) < 2, `link preview detached after scroll at ${scale}`);
  await page.mouse.move(previewAfter.x+previewAfter.width/2, previewAfter.y+previewAfter.height/2, { steps: 5 });
  await page.waitForTimeout(100);
  check(await preview.getAttribute('data-show') === 'true', 'hover transfer dismissed preview');
  await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop += 900; });
  await page.waitForTimeout(100);
  check(await preview.getAttribute('data-show') === 'false', 'offscreen hovered source retained preview');
  await page.locator('.ProseMirror a').nth(8).evaluate(el => el.scrollIntoView({block:'center'}));
  await page.locator('.ProseMirror a').nth(8).hover();
  await page.waitForTimeout(100);
  check(await preview.getAttribute('data-show') === 'true', 'preview did not recover after source loss');
  check(await page.evaluate(() => (window as any).audit.crepe.getMarkdown()) === originalMarkdown, 'zoom, selection or hover changed Markdown');
  await page.evaluate(() => (window as any).audit.comment(8));
  const composer = page.locator('.wm-comment-popover');
  await composer.locator('textarea').fill('Keep this draft');
  await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop += 30; });
  await page.waitForTimeout(80);
  check(await composer.locator('textarea').inputValue() === 'Keep this draft', 'comment lost input while repositioning');
  const formBox = await composer.boundingBox();
  check(formBox && formBox.x >= 0 && formBox.y >= 44 && formBox.x + formBox.width <= 1200 && formBox.y + formBox.height <= 800, 'comment outside canvas');
  await composer.getByRole('button', { name: 'Comment', exact: true }).click();
  check(await page.locator('.wm-annotation-highlight').count() > 0, 'comment highlight missing');
  await page.locator('.ProseMirror p').nth(25).scrollIntoViewIfNeeded();
  const readAnchor = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror > p')].find(p => p.getBoundingClientRect().bottom > 68)!;
    (window as any).readingIndex = [...document.querySelectorAll('.ProseMirror > p')].indexOf(p);
    return p.getBoundingClientRect().top;
  });
  await page.evaluate(z => (window as any).audit.setZoom(z), scale === 1 ? 1.13 : 1);
  await page.waitForTimeout(150);
  const afterZoom = await page.evaluate(() => document.querySelectorAll('.ProseMirror > p')[(window as any).readingIndex]!.getBoundingClientRect().top);
  check(Math.abs(afterZoom - readAnchor) < 35, `reading anchor drift ${afterZoom - readAnchor} at ${scale}`);
  await page.evaluate(z => (window as any).audit.setZoom(z), scale);
  await page.evaluate(() => {
    const rail = document.createElement('aside'); rail.className = 'wm-annotation-rail';
    document.querySelector('#annotations')!.append(rail);
  });
  await page.waitForTimeout(150);
  check(await page.evaluate(() => Math.abs(document.querySelector('.wm-canvas-stage')!.getBoundingClientRect().height - document.querySelector('.wm-canvas-scene')!.getBoundingClientRect().height) < 1.1), 'stage lost height after rail reflow');
  await page.evaluate(() => document.querySelector('.wm-annotation-rail')?.remove());
  await page.locator('.milkdown-code-block').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const code = await page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('.cm-scroller')!;
    node.scrollLeft = 200;
    return { scrolled: node.scrollLeft, overflow: node.scrollWidth > node.clientWidth };
  });
  check(code.overflow && code.scrolled > 0, `nested code scroll at ${scale}`);
  const languageButton = page.locator('.language-button');
  await languageButton.click();
  await page.waitForTimeout(100);
  const language = await page.locator('.language-picker').boundingBox();
  check(language && language.x >= 0 && language.y >= 44 && language.x + language.width <= 1200 && language.y + language.height <= 800, 'language menu outside visible canvas');
  await languageButton.click();
  const image = page.locator('.milkdown-image-block img');
  await image.evaluate(el => el.scrollIntoView({block: 'center'}));
  await page.waitForTimeout(100);
  const imageBox = await image.boundingBox();
  check(imageBox, 'image not rendered');
  const handle = page.locator('.image-resize-handle');
  await image.hover();
  const handleBox = await handle.boundingBox();
  check(handleBox, 'image resize handle missing');
  await page.mouse.move(handleBox.x + handleBox.width/2, handleBox.y + handleBox.height/2);
  await page.mouse.down();
  const targetY = imageBox.y + Math.max(110 * scale, imageBox.height - 35);
  await page.mouse.move(imageBox.x + imageBox.width/2, targetY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const resized = await image.boundingBox();
  check(resized && Math.abs(resized.y + resized.height - targetY) < 3, `image resize missed pointer at ${scale}: ${JSON.stringify({resized,targetY})}`);
  const cell = page.locator('.milkdown-table-block td').first();
  await cell.evaluate(el => el.scrollIntoView({block: 'center'}));
  await cell.hover();
  await page.waitForTimeout(100);
  const colHandle = page.locator('[data-role="col-drag-handle"]');
  await colHandle.click();
  await page.waitForTimeout(100);
  const tableMenu = colHandle.locator('.button-group');
  check(await tableMenu.getAttribute('data-show') === 'true', 'table action menu missing');
  const action = tableMenu.locator('button').nth(1);
  check(await action.evaluate(el => {const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}), 'table action button clipped or covered');
  await action.click();
  check(await page.locator('.milkdown-table-block th').first().getAttribute('align') === 'center' || await page.locator('.milkdown-table-block th').first().evaluate(el => getComputedStyle(el).textAlign === 'center'), 'table alignment action failed');
  await page.addStyleTag({ content: '.milkdown-table-block { overflow-x: auto; } .milkdown-table-block table { min-width: 1600px; }' });
  const lastCell = page.locator('.milkdown-table-block td').last();
  await lastCell.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  const tableCaret = await page.evaluate(() => {
    const v = (window as any).audit.view;
    const c = v.coordsAtPos(v.state.selection.head);
    const scroller = document.querySelector('.milkdown-table-block')!;
    const b = scroller.getBoundingClientRect();
    return { caret: c.left, left: b.left, right: b.right, scroll: scroller.scrollLeft, text: v.state.selection.$from.parent.textContent };
  });
  check(tableCaret.text === 'cell two' && tableCaret.scroll > 0 && tableCaret.caret >= tableCaret.left && tableCaret.caret <= tableCaret.right, `nested table caret scroll at ${scale}: ${JSON.stringify(tableCaret)}`);
  await page.evaluate(() => { const scroller = document.querySelector('.wm-document-scroll')!; scroller.scrollTop = scroller.scrollHeight; });
  const bottom = await page.locator('.ProseMirror p').last().boundingBox();
  check(bottom && bottom.y >= 0 && bottom.y + bottom.height <= 800, `last paragraph unreachable at ${scale}`);
  const toolbar = await page.locator('.milkdown-top-bar').boundingBox();
  check(toolbar && Math.abs(toolbar.y) < 1, `toolbar not sticky at ${scale}`);
  await page.evaluate(() => {
    const {view, selection, selectLink} = (window as any).audit;
    selectLink(8); selection.openTags(view);
    view.dispatch(view.state.tr.insertText('inserted ', 1));
  });
  const tags = page.locator('.wm-tags');
  check(await tags.isVisible(), 'tag form discarded on document mutation');
  const unchanged = await page.evaluate(() => (window as any).audit.crepe.getMarkdown());
  await tags.locator('.wm-tag-name').first().click();
  check(await page.locator('.wm-tag-detail').count() === 0, 'stale tag descriptor opened detail');
  check(await page.evaluate(() => (window as any).audit.crepe.getMarkdown()) === unchanged, 'stale tag action mutated document');
  await page.evaluate(() => {
    const {view, selection} = (window as any).audit; selection.close();
    const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('A long wrapped passage with many words. '.repeat(150)));
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop = 500; });
  const visibleY = await page.evaluate(() => {
    const text = document.querySelector('.ProseMirror > p')!.firstChild!;
    const range = document.createRange();
    for(let offset=0;offset<text.textContent!.length;offset++) {
      range.setStart(text,offset);range.setEnd(text,offset+1);
      if(range.getBoundingClientRect().bottom > 68) break;
    }
    (window as any).visibleRange=range;
    return range.getBoundingClientRect().top;
  });
  await page.evaluate(z => (window as any).audit.setZoom(z), scale === 1 ? 1.13 : 1);
  await page.waitForTimeout(180);
  check(Math.abs(await page.evaluate(() => (window as any).visibleRange.getBoundingClientRect().top) - visibleY) < 3, 'long passage reading anchor drift');
  console.log(`PASS canvas scale=${scale}`);
}
try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    let browser: Browser | undefined;
    try {
      browser = endpoints ? await type.connect(endpoints[name]!, { timeout: 10000 }) : await type.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('Fixture error:', error.message));
      page.setDefaultTimeout(10000);
      console.log(`${name} ${browser.version()}`);
      for (const scale of [.75, 1, 1.13, 1.25, 1.75]) await topology(page, scale);
      await context.close();
    } finally { await browser?.close(); }
  }
} finally { server.stop(); await rm(outdir, { recursive: true, force: true }); }
