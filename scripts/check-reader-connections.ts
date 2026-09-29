import { chromium, webkit } from 'playwright';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
import { PaseoHostAdapter } from '../src/hosts/paseo';
import { controlRecentsLaunch } from '../src/server/lifecycle';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'tether-connections-')));
const config = resolveConfig({ profile: 'test', configDir: join(directory, 'config'), runtimeDir: join(directory, 'runtime') });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), hostAdapter: new PaseoHostAdapter({ enqueue: async () => {} }), opener: async () => {} });
try {
  await daemon.ready;
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      context.setDefaultTimeout(8000);
      const protocol = join(directory, `${name}-protocol.md`), archived = join(directory, `${name}-archived.md`);
      await writeFile(protocol, '# Protocol\n'); await writeFile(archived, '# Archived\n');
      const seed = await context.newPage();
      await seed.goto(daemon.mintTicket(await daemon.service.open(archived)).url);
      await seed.locator('.ProseMirror').waitFor(); await seed.close();
      const folios = [];
      for (let i = 0; i < 3; i++) {
        const page = await context.newPage();
        await page.goto((await controlRecentsLaunch(config)).url);
        folios.push(page);
      }
      const status = await folios[0]!.evaluate(async path => (await fetch('api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, action: 'archive', confirmed: true }) })).status, archived);
      if (status !== 200) throw new Error(`Archive failed: ${status}`);
      const readers = [];
      for (let i = 0; i < 8; i++) {
        const path = join(directory, `${name}-reader-${i}.md`);
        await writeFile(path, `# Reader ${i}\n\n[Protocol](${name}-protocol.md)\n\n[[${name}-archived.md|Archived]]\n`);
        const page = await context.newPage();
        await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
        await page.locator('.ProseMirror').waitFor(); readers.push(page);
      }
      const reader = readers.at(-1)!;
      await reader.reload(); await reader.locator('.ProseMirror').waitFor();
      for (const label of ['Protocol', 'Archived']) {
        const [opened] = await Promise.all([context.waitForEvent('page'), reader.getByRole('link', { name: label, exact: true }).click()]);
        await opened.locator('.ProseMirror').waitFor();
        if (!(await opened.locator('.ProseMirror').innerText()).includes(label)) throw new Error(`${label} did not open`);
      }
      for (const folio of folios) {
        const snapshot = await folio.evaluate(async () => (await fetch('api/snapshot', { signal: AbortSignal.timeout(4000) })).json());
        if (!snapshot.files.some((file: { path: string }) => file.path.endsWith(`${name}-protocol.md`))) throw new Error('Folio did not update');
      }
      await reader.evaluate(async () => { await fetch('api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiScale: 1.25 }) }); });
      for (const page of [...readers, ...folios]) {
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--wm-ui-scale').trim() === '1.25');
      }
      // Already-open clients from older builds must also relinquish their slots.
      await reader.evaluate(() => { for (let i = 0; i < 6; i++) new EventSource('api/theme-events'); });
      await reader.waitForTimeout(300);
      const responsive = await reader.evaluate(async () => (await fetch('api/preferences', { signal: AbortSignal.timeout(5000) })).ok);
      if (!responsive) throw new Error('Legacy streams blocked requests');
      console.log(`${name}: eight readers, three Folios, archived/new links, appearance updates, and legacy streams passed`);
    } finally { await browser.close(); }
  }
} finally { await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
