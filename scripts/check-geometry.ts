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
// Track the first readable character, not its paragraph's offscreen top.
// Use a linear scan independently of the canvas's binary-search implementation.
async function captureReadingAnchor(page: Page): Promise<number> {
  return page.evaluate(() => {
    const toolbar = document.querySelector('.milkdown-top-bar')!.getBoundingClientRect();
    const readingTop = Math.max(toolbar.bottom, 0) + 24;
    for (const block of document.querySelector('.ProseMirror')!.children) {
      const box = block.getBoundingClientRect();
      if (box.bottom <= readingTop || box.top >= innerHeight) continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        for (let offset = 0; offset < text.textContent.length; offset++) {
          range.setStart(text, offset); range.setEnd(text, offset + 1);
          const rect = range.getBoundingClientRect();
          if (rect.height && rect.bottom > readingTop && rect.top < innerHeight) {
            (window as any).readingAnchor = range;
            return rect.top;
          }
        }
      }
    }
    throw new Error('No visible reading anchor in fixture');
  });
}
async function readerStartup(page: Page, kind: string, scale: number) {
  await page.mouse.move(1195, 795);
  await page.goto(new URL(`?startup=${kind}&scale=${scale}`, server.url).toString());
  await page.waitForFunction(() => (window as any).ready && [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => {
    const { view, crepe, canvas } = (window as any).audit;
    return { focused: view.hasFocus(), selectionEmpty: view.state.selection.empty,
      nativeRanges: document.getSelection()?.rangeCount, scrollTop: canvas.scroller.scrollTop,
      pageScroll: window.scrollY, selectedImages: view.dom.querySelectorAll('.milkdown-image-block.selected').length,
      visibleGap: [...view.dom.querySelectorAll('.ProseMirror-gapcursor')].some(node => getComputedStyle(node as Element).display !== 'none'),
      headingTop: view.dom.querySelector('h1')?.getBoundingClientRect().top, markdown: crepe.getMarkdown() };
  });
  check(!state.focused && state.selectionEmpty && state.nativeRanges === 0 && !state.visibleGap && !state.selectedImages,
    `startup is not neutral (${kind}, ${scale}): ${JSON.stringify(state)}`);
  check(state.scrollTop === 0 && state.pageScroll === 0, `startup scrolled (${kind}, ${scale}): ${JSON.stringify(state)}`);
  if (kind === 'long-prefix') check(state.headingTop > 800, 'startup fixture must put its first text below the viewport');
  const image = page.locator('.milkdown-image-block img').first();
  await image.click();
  await page.waitForTimeout(50);
  check(await page.locator('.milkdown-image-block.selected').count() === 1, 'intentional image selection failed after neutral startup');
  check(await page.evaluate(() => (window as any).audit.crepe.getMarkdown()) === state.markdown, 'startup or image selection changed Markdown');
  console.log(`PASS reader startup=${kind} scale=${scale}`);
}
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
  const exactPoint = await page.locator('.ProseMirror p').nth(5).evaluate(el => {
    const range = document.createRange(); range.setStart(el.firstChild!, 7); range.setEnd(el.firstChild!, 8);
    const rect = range.getBoundingClientRect(); return { x: rect.left + .1, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.click(exactPoint.x, exactPoint.y);
  await page.waitForTimeout(40);
  const painted = await page.evaluate(() => {
    const selection = document.getSelection()!;
    const range = selection.getRangeAt(0).getBoundingClientRect();
    const cursor = document.querySelector('.prosemirror-virtual-cursor')!.getBoundingClientRect();
    return { offset: selection.focusOffset, dx: cursor.left - range.left, dy: cursor.top - range.top, dh: cursor.height - range.height };
  });
  check(painted.offset === 7 && Math.abs(painted.dx) <= 2 && Math.abs(painted.dy) < 1 && Math.abs(painted.dh) < 1,
    `painted caret does not match selection at ${scale}: ${JSON.stringify(painted)}`);
  const drag = await page.locator('.ProseMirror p').nth(5).evaluate(el => {
    const range = document.createRange(); range.setStart(el.firstChild!, 1); range.setEnd(el.firstChild!, 10);
    const r = range.getBoundingClientRect(); return { x: r.left, y: (r.top + r.bottom) / 2, end: r.right };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.end, drag.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => !(window as any).audit.view.state.selection.empty);
  check(await page.evaluate(() => Boolean(document.getSelection()?.toString())), `native range selection at ${scale}`);
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
  check(formBox && formBox.x >= 0 && formBox.y >= 36 && formBox.x + formBox.width <= 1200 && formBox.y + formBox.height <= 800, 'comment outside canvas');
  await composer.getByRole('button', { name: 'Comment', exact: true }).click();
  check(await page.locator('.wm-annotation-highlight').count() > 0, 'comment highlight missing');
  await page.locator('.ProseMirror p').nth(25).scrollIntoViewIfNeeded();
  const readAnchor = await captureReadingAnchor(page);
  await page.evaluate(z => (window as any).audit.setZoom(z), scale === 1 ? 1.13 : 1);
  await page.waitForTimeout(180);
  const afterZoom = await page.evaluate(() => (window as any).readingAnchor.getBoundingClientRect().top);
  check(Math.abs(afterZoom - readAnchor) < 3, `reading anchor drift at scale=${scale}: before=${readAnchor}, after=${afterZoom}`);
  await page.evaluate(z => (window as any).audit.setZoom(z), scale);
  await page.evaluate(() => {
    const rail = document.createElement('aside'); rail.className = 'wm-annotation-rail'; rail.dataset.open = 'true';
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
  check(language && language.x >= 0 && language.y >= 36 && language.x + language.width <= 1200 && language.y + language.height <= 800, 'language menu outside visible canvas');
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
  check(toolbar && toolbar.height === 36 && Math.abs(toolbar.y) < 1, `toolbar not sticky at ${scale}`);
  await page.evaluate(() => {
    const {view, selection} = (window as any).audit; selection.close();
    const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('A long wrapped passage with many words. '.repeat(150)));
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => { document.querySelector('.wm-document-scroll')!.scrollTop = 500; });
  const visibleY = await captureReadingAnchor(page);
  await page.evaluate(z => (window as any).audit.setZoom(z), scale === 1 ? 1.13 : 1);
  await page.waitForTimeout(180);
  const afterY = await page.evaluate(() => (window as any).readingAnchor.getBoundingClientRect().top);
  check(Math.abs(afterY - visibleY) < 3, `long passage reading anchor drift at scale=${scale}: before=${visibleY}, after=${afterY}`);
  console.log(`PASS canvas scale=${scale}`);
}
async function selectionMenuScale(page: Page) {
  await page.mouse.move(1195, 795);
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).ready);
  for (const zoom of [.75, 1.75]) {
    await page.evaluate(zoom => {
      const a = (window as any).audit;
      a.setZoom(zoom); a.view.focus(); a.selectLink(0);
    }, zoom);
    const toolbar = page.locator('.milkdown-toolbar');
    await toolbar.waitFor({ state: 'visible' });
    for (const scale of [.7, 1, 1.5]) {
      await page.evaluate(scale => document.documentElement.style.setProperty('--wm-ui-scale', String(scale)), scale);
      const size = await toolbar.locator('.toolbar-item').first().boundingBox();
      check(size && Math.abs(size.width - 26 * scale) < 1 && Math.abs(size.height - 26 * scale) < 1,
        `selection menu ignores interface scale or inherits document zoom: ${zoom}/${scale}: ${JSON.stringify(size)}`);
      const bounds = await toolbar.boundingBox();
      check(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 1201, 'selection menu escapes viewport');
    }
  }
  console.log('PASS selection menu scale independent of document zoom');
}
async function appearanceGeometry(page: Page) {
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).ready);
  await page.evaluate(() => (window as any).audit.overflowThread());
  await page.waitForTimeout(250);
  const assertOverflow = async (selector: string) => check(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth), `reply overflow in ${selector}`);
  await assertOverflow('.wm-annotation-rail-scroll');
  const handle = page.getByRole('separator', { name: 'Threads width' });
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  check(await handle.getAttribute('aria-valuenow') === '316', 'focused arrow resize');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x - 81, box.y + 100); await page.mouse.up();
  check(await handle.getAttribute('aria-valuenow') === '400', 'pointer resize');
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(60);
  check(await handle.getAttribute('aria-valuenow') === '380', 'pane clamps rail to document minimum');
  check(await page.evaluate(() => (window as any).savedRailWidth) === 400, 'reflow must not save clamped width');
  await page.setViewportSize({ width: 1200, height: 800 }); await page.waitForTimeout(60);
  check(await handle.getAttribute('aria-valuenow') === '400', 'widen restores saved width');
  for (const scale of [.7, 1, 1.5]) {
    await page.evaluate(scale => document.documentElement.style.setProperty('--wm-ui-scale', String(scale)), scale);
    await assertOverflow('.wm-annotation-rail-scroll');
    check(await page.locator('.milkdown-top-bar').evaluate(el => el.getBoundingClientRect().height) === 36 * Math.max(1, scale), 'topbar scale floor');
  }
  await page.evaluate(() => { const a = (window as any).audit.annotations; a.setRailOpen(false); a.openThread('overflow'); });
  await assertOverflow('.wm-thread-popover');
  check(await page.locator('.wm-thread-popover pre').evaluate(el => el.scrollWidth > el.clientWidth), 'long code scrolls internally');
  await page.setViewportSize({ width: 600, height: 800 });
  await page.evaluate(() => (window as any).audit.annotations.setRailOpen(true));
  check(!await handle.isVisible(), 'mobile overlay hides resize handle');
  await page.setViewportSize({ width: 1200, height: 800 });
  console.log('PASS overflow, rail resize, reflow, and interface scale');
}
async function fontAndMediaSizing(page: Page) {
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).ready);
  await page.evaluate(() => (window as any).audit.openMaker());
  const size = page.locator('[data-metric="bodySize"]');
  await size.evaluate((el: HTMLInputElement) => { el.value = '13.9'; el.dispatchEvent(new Event('input')); });
  await size.focus(); await page.keyboard.press('ArrowRight');
  check(await size.inputValue() === '14', 'point slider cannot select exactly 14pt');
  await page.evaluate(() => document.fonts.ready);
  const rendered = await page.locator('.ProseMirror > p').first().evaluate(el => ({
    font: parseFloat(getComputedStyle(el).fontSize), line: parseFloat(getComputedStyle(el).lineHeight),
    height: el.getBoundingClientRect().height,
  }));
  check(Math.abs(rendered.font - 14 * 4 / 3) < .001, `14pt font is not 18⅔ CSS px: ${JSON.stringify(rendered)}`);
  check(Math.abs(rendered.height / rendered.line - Math.round(rendered.height / rendered.line)) < .01, '100% zoom secretly scales rendered text');
  await page.goto(new URL('?ratio', server.url).toString());
  await page.waitForFunction(() => (window as any).ready && [...document.images].every(i => i.complete && i.naturalWidth));
  const image = page.locator('.milkdown-image-block img');
  await image.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const box = (await image.boundingBox())!;
  check(Math.abs(box.height - 96) < 1, `saved image ratio did not rebase: ${box.height}`);
  const before = await page.evaluate(() => (window as any).audit.crepe.getMarkdown());
  await page.evaluate(() => (window as any).audit.setZoom(1.25));
  await page.waitForTimeout(100);
  check(Math.abs((await image.boundingBox())!.height - 120) < 1, 'saved image ratio does not restore at 125%');
  check(await page.evaluate(() => (window as any).audit.crepe.getMarkdown()) === before, 'media sizing rewrote Markdown');
  await page.evaluate(() => (window as any).audit.setZoom(1));
  await image.scrollIntoViewIfNeeded(); await image.hover();
  const handle = (await page.locator('.image-resize-handle').boundingBox())!;
  const current = (await image.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(current.x + current.width / 2, current.y + 85, { steps: 5 }); await page.mouse.up();
  check(Math.abs((await image.boundingBox())!.height - 85) < 1, 'rebased image jumps to legacy resize minimum');
  console.log('PASS point rendering and saved image ratio/resize');
}
async function documentSizing(page: Page, browser: string) {
  const measurements: Record<string, unknown> = {};
  for (const width of [1200, 600]) for (const custom of [false, true]) for (const zoom of [.8, 1]) {
    const scale = process.env.TETHER_SIZING_CAPTURE ? zoom : zoom / .8;
    await page.setViewportSize({ width, height: 800 });
    await page.goto(new URL(`?scale=${scale}${custom ? '&custom' : ''}`, server.url).toString());
    await page.waitForFunction(() => (window as any).ready && [...document.images].every(i => i.complete && i.naturalWidth));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    measurements[`${width}/${custom}/${zoom}`] = await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror')!;
      const top = editor.getBoundingClientRect().top;
      return [...editor.querySelectorAll('h1, p, img, th, td, .milkdown-code-block')].map(el => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, x: r.x, y: r.y - top, width: r.width, height: r.height };
      });
    });
  }
  const path = `${process.env.TETHER_SIZING_CAPTURE ?? process.env.TETHER_SIZING_COMPARE}-${browser}.json`;
  if (process.env.TETHER_SIZING_CAPTURE) await Bun.write(path, JSON.stringify(measurements, null, 2));
  else {
    const previous = await Bun.file(path).json();
    for (const [key, rows] of Object.entries(measurements)) {
      for (const [i, row] of (rows as any[]).entries()) for (const metric of ['x', 'y', 'width', 'height']) {
        const delta = Math.abs(row[metric] - previous[key][i][metric]);
        // Font line boxes and collapsed borders round before canvas transforms.
        check(delta < (metric === 'y' ? 4 : 2), `sizing ${browser} ${key} ${i} ${row.tag} ${metric}: ${row[metric]} vs ${previous[key][i][metric]}`);
      }
    }
    console.log(`PASS document sizing ${browser}`);
  }
  await page.setViewportSize({ width: 1200, height: 800 });
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
      if (process.env.TETHER_SIZING_CAPTURE || process.env.TETHER_SIZING_COMPARE) {
        await documentSizing(page, name);
        await context.close();
        continue;
      }
      await fontAndMediaSizing(page);
      await selectionMenuScale(page);
      await appearanceGeometry(page);
      for (const kind of ['long-prefix', 'image-only']) for (const scale of [1, 1.25]) await readerStartup(page, kind, scale);
      for (const scale of [.75, 1, 1.13, 1.25, 1.75]) await topology(page, scale);
      await context.close();
    } finally { await browser?.close(); }
  }
} finally { server.stop(); await rm(outdir, { recursive: true, force: true }); }
