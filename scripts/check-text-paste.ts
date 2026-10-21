import { chromium } from 'playwright';
import { basename } from 'node:path';
import { folioHtml } from '../src/web/folio-page';

// Exercise the real composer and native editing history, which JSDOM cannot model.
const build = await Bun.build({ entrypoints: ['./src/web/annotations-ui.ts', './src/web/text-paste.ts', './src/web/agent-rename.ts'], target: 'browser', format: 'esm' });
if (!build.success) throw new Error(String(build.logs));
const assets = new Map(build.outputs.map(output => ['/' + basename(output.path), output]));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/folio') return new Response(folioHtml(), { headers: { 'content-type': 'text/html' } });
  if (path.startsWith('/api/')) return Response.json({ instanceId: 'test', sequence: 1, files: [], filters: [], retention: { mode: 'forever' } });
  if (path !== '/') return assets.has(path) ? new Response(assets.get(path)) : new Response(null, { status: 404 });
  return new Response(`<!doctype html><div id="root"></div><script type="module">
    import { createAnnotationUi } from '/annotations-ui.js';
    import { pasteTextInput } from '/text-paste.js';
    import { openAgentRename } from '/agent-rename.js';
    document.addEventListener('paste', pasteTextInput);
    const ui = createAnnotationUi({ root: document.querySelector('#root') });
    window.testReply = () => {
      ui.setState({ threads: [{ id: 'test', actor: 'human', createdAt: new Date().toISOString(), body: 'Original',
        anchor: { exact: 'passage', prefix: '', suffix: '', projectionStart: 0, projectionEnd: 7 },
        replies: [{ id: 'reply', actor: 'human', createdAt: new Date().toISOString(), body: 'Reply' }] }] });
      ui.openThread('test');
    };
    window.testRename = () => openAgentRename({ x: 0, y: 0, name: 'Agent', save: async () => {} });
    ui.openCommentComposer({ exact: 'passage', prefix: '', suffix: '', projectionStart: 0,
      projectionEnd: 7, bodyRevision: 'sha256:' + '0'.repeat(64) });
  </script>`, { headers: { 'content-type': 'text/html' } });
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.addEventListener('paste', event => { (window as any).pasteHandled = event.defaultPrevented; });
  });
  await page.goto(server.url.href);
  const field = page.locator('.wm-annotation-composer textarea');
  await field.waitFor();
  await field.focus();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const paste = async (text: string, handled = true) => {
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await page.keyboard.press(`${modifier}+V`);
    check(await page.evaluate(() => (window as any).pasteHandled) === handled, 'Paste did not take the expected event-data path');
  };
  const undo = () => page.keyboard.press(`${modifier}+Z`);
  const redo = () => page.keyboard.press(`${modifier}+Shift+Z`);
  const inputs = Array.from({ length: 12 }, (_, i) => `Dictation ${i + 1}\n`);
  let expected = '';
  for (const text of inputs) {
    await paste(text);
    expected += text;
    check(await field.inputValue() === expected, 'Consecutive paste was lost or duplicated');
  }
  for (let i = inputs.length - 1; i >= 0; i--) {
    await undo();
    check(await field.inputValue() === inputs.slice(0, i).join(''), 'Undo did not remove exactly one paste');
  }
  for (let i = 0; i < inputs.length; i++) {
    await redo();
    check(await field.inputValue() === inputs.slice(0, i + 1).join(''), 'Redo did not restore exactly one paste');
  }
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 9, 'backward'));
  const replacement = 'Replacement 🌿\nsecond line';
  await paste(replacement);
  check(await field.inputValue() === replacement + expected.slice(9), 'Selected text replacement failed');
  await undo();
  check(await field.inputValue() === expected, 'Replacement undo failed');
  await field.evaluate(el => { (el as HTMLTextAreaElement).readOnly = true; });
  await paste('must not insert', false);
  check(await field.inputValue() === expected, 'Read-only composer was modified');
  await field.evaluate(el => { (el as HTMLTextAreaElement).readOnly = false; });
  // An earlier handler may veto a paste; this workaround must respect it.
  await field.evaluate(el => el.ownerDocument.addEventListener('paste', event => event.preventDefault(), { capture: true, once: true }));
  await paste('cancelled');
  check(await field.inputValue() === expected, 'Cancelled paste was inserted');
  await page.evaluate(() => (window as any).testReply());
  const verifyField = async (selector: string) => {
    const input = page.locator(`${selector}:visible`).first();
    await input.focus();
    const original = await input.inputValue();
    await page.keyboard.press('End');
    for (const text of [' one', ' two']) await paste(text);
    check(await input.inputValue() === original + ' one two', `${selector}: paste failed`);
    await undo();
    check(await input.inputValue() === original + ' one', `${selector}: separate Undo failed`);
    await undo();
    check(await input.inputValue() === original, `${selector}: second Undo failed`);
    await redo(); await redo();
    check(await input.inputValue() === original + ' one two', `${selector}: Redo failed`);
  };
  await verifyField('.wm-annotation-reply-form textarea');
  await page.getByRole('button', { name: 'Edit comment', exact: true }).click();
  await verifyField('textarea[aria-label="Edit comment text"]');
  await page.getByRole('button', { name: 'Edit reply', exact: true }).click();
  await verifyField('textarea[aria-label="Edit reply text"]');
  await page.evaluate(() => (window as any).testRename());
  await verifyField('.wm-agent-rename input');
  for (const type of ['text', 'search', 'url', 'tel', 'password']) {
    await page.evaluate(type => { const input = document.createElement('input'); input.id = 'test-input'; input.type = type; document.body.append(input); }, type);
    await verifyField('#test-input');
    await page.locator('#test-input').evaluate(el => el.remove());
  }
  for (const [type, text] of [['email', 'test@example.com'], ['number', '123']]) {
    await page.evaluate(type => { const input = document.createElement('input'); input.id = 'test-input'; input.type = type; document.body.append(input); }, type);
    const input = page.locator('#test-input'); await input.focus(); await paste(text);
    check(await input.inputValue() === text, `${type}: paste failed`);
    await undo(); check(await input.inputValue() === '', `${type}: Undo failed`);
    await redo(); check(await input.inputValue() === text, `${type}: Redo failed`);
    await input.evaluate(el => el.remove());
  }
  check(errors.length === 0, errors.join('\n'));
  await page.goto(new URL('/folio', server.url).href);
  await verifyField('#filter');
  check(errors.length === 0, errors.join('\n'));
  console.log('Text paste: consecutive pastes, Undo/Redo, replacement, cancellation, replies, edits, rename and all text input types passed.');
} finally {
  await browser?.close();
  server.stop(true);
}
