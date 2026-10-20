import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../../src/server/config';
import { builtInThemes, builtInDesign, storedPreferencesFrom } from '../../src/shared/themes';
import { rows } from './catalog';
import { createGoPicker } from './go-icons';

const root = resolve(import.meta.dir, '../..');
const assets = join(root, 'node_modules/lucide-static/icons');
export type Choice = { candidates: string[]; selected: string | null; showCurrent: boolean; draft: string };
export type PickerState = { version: 1; revision: number; updatedAt: string; theme: string; scale: number; rows: Record<string, Choice> };

export async function startPicker(options: { port?: number; proxyOrigin?: string; statePath?: string; turnIconsDirectory?: string } = {}) {
  const proxy = options.proxyOrigin && new URL(options.proxyOrigin);
  if (proxy && (proxy.protocol !== 'http:' || !proxy.hostname.endsWith('.localhost') || proxy.origin !== options.proxyOrigin)) throw new Error('Expected a local Paseo service origin.');
  const statePath = options.statePath ?? join(root, '.local/icon-picker/selections.json');
  const names = new Set((await readdir(assets)).filter(n => n.endsWith('.svg')).map(n => n.slice(0, -4)));
  const preferencesFile = Bun.file(resolveConfig().preferencesPath);
  const preferences = storedPreferencesFrom(await preferencesFile.exists() ? await preferencesFile.json() : null);
  const themes = [...builtInThemes.map(t => ({ id: t.value as string, label: t.label as string, design: builtInDesign(t.value)! })),
    ...preferences.customThemes.map(t => ({ id: t.id, label: t.name, design: t }))];
  const catalog = rows.map(row => ({ ...row, suggestions: row.suggestions.filter(name => names.has(name)) }));
  let state: PickerState = {
    version: 1, revision: 0, updatedAt: new Date().toISOString(), theme: preferences.theme, scale: 1,
    rows: Object.fromEntries(catalog.map(row => [row.id, { candidates: row.suggestions, selected: row.lucide, showCurrent: true, draft: '' }])),
  };
  function validate(value: unknown): asserts value is PickerState {
    if (!value || typeof value !== 'object') throw new Error('Invalid preferences');
    const s = value as PickerState;
    if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !themes.some(t => t.id === s.theme) ||
      !Number.isFinite(s.scale) || s.scale < 0.5 || s.scale > 2.5 || !s.rows || typeof s.rows !== 'object' ||
      Object.keys(s.rows).length !== catalog.length) throw new Error('Invalid preferences');
    for (const row of catalog) {
      const c = s.rows[row.id];
      if (!c || !Array.isArray(c.candidates) || c.candidates.length > 100 ||
        c.candidates.some(n => typeof n !== 'string' || !names.has(n)) || new Set(c.candidates).size !== c.candidates.length ||
        (c.selected !== null && !c.candidates.includes(c.selected)) || typeof c.showCurrent !== 'boolean' ||
        typeof c.draft !== 'string' || c.draft.length > 200) throw new Error(`Invalid choices for ${row.id}`);
    }
  }
  // Include source locations in the on-disk record for future implementation work.
  async function persist(next: PickerState) {
    await mkdir(dirname(statePath), { recursive: true });
    const record = { ...next, library: 'lucide-static', libraryVersion: (await Bun.file(join(assets, '../package.json')).json()).version,
      controls: catalog.map(({ id, label, area, source, phosphor, lucide, size, note, targets }) => ({ id, label, area, source, phosphor, lucide, defaultSize: size, note, targets })) };
    await writeFile(`${statePath}.tmp`, JSON.stringify(record, null, 2) + '\n');
    await rename(`${statePath}.tmp`, statePath);
  }
  try {
    const loaded = JSON.parse(await readFile(statePath, 'utf8'));
    // Extend an existing catalog without replacing choices, removals, or input drafts.
    if (!loaded.rows || typeof loaded.rows !== 'object' || Array.isArray(loaded.rows)) throw new Error('Invalid saved rows');
    const additions = catalog.filter(row => !Object.hasOwn(loaded.rows, row.id));
    for (const row of additions) loaded.rows[row.id] = state.rows[row.id];
    validate(loaded);
    state = { version: 1, revision: loaded.revision, updatedAt: loaded.updatedAt, theme: loaded.theme, scale: loaded.scale, rows: loaded.rows };
    if (additions.length) {
      state.revision++; state.updatedAt = new Date().toISOString(); await persist(state);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await persist(state);
  }
  let writes = Promise.resolve();
  let goPicker: ReturnType<typeof createGoPicker> | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 4319, maxRequestBodySize: 128 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const allowedOrigins = [server.url.origin, options.proxyOrigin];
      if (!allowedOrigins.includes(url.origin) || request.headers.get('host') !== url.host ||
        (request.headers.get('origin') && request.headers.get('origin') !== url.origin)) return new Response('Forbidden', { status: 403 });
      const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/api/go-icons') {
        try {
          goPicker ??= createGoPicker(options.turnIconsDirectory ?? join(root, '.local/turn-icons'), join(dirname(statePath), 'go-selections.json'));
          return await (await goPicker)(request);
        } catch (error) {
          goPicker = undefined;
          return json({ error: (error as Error).message }, 500);
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') return json({ catalog, themes, state, statePath });
      if (request.method === 'GET' && url.pathname === '/api/state') return json(state);
      if (request.method === 'PUT' && url.pathname === '/api/state') {
        if (request.headers.get('content-type') !== 'application/json' || request.headers.get('origin') !== url.origin) return json({ error: 'Same-origin JSON required' }, 403);
        let answer!: Response;
        const work = writes.then(async () => {
          try {
            const proposed: unknown = await request.json();
            if (proposed && typeof proposed === 'object' && 'revision' in proposed && proposed.revision !== state.revision) { answer = json({ error: 'Choices or available controls changed. Reload before editing further.' }, 409); return; }
            validate(proposed);
            const next: PickerState = { version: 1, revision: state.revision + 1, updatedAt: new Date().toISOString(), theme: proposed.theme, scale: proposed.scale,
              rows: Object.fromEntries(catalog.map(row => [row.id, proposed.rows[row.id]])) };
            await persist(next); state = next; answer = json({ revision: state.revision, updatedAt: state.updatedAt });
          } catch (error) { answer = json({ error: (error as Error).message }, 400); }
        });
        writes = work.catch(() => {}); await work; return answer;
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const match = /^\/icons\/([a-z0-9-]+)\.svg$/.exec(url.pathname);
      if (match) return names.has(match[1]!) ? new Response(Bun.file(join(assets, `${match[1]}.svg`))) : new Response('Unknown Lucide icon', { status: 404 });
      const staticFiles: Record<string, string> = { '/go-icons': 'go-icons.html', '/go-icons.js': 'go-icons.js', '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      if (Object.hasOwn(staticFiles, url.pathname)) return new Response(Bun.file(join(import.meta.dir, staticFiles[url.pathname]!)), { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/fonts.css') return new Response(Bun.file(join(root, 'src/web/fonts.css')));
      if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname)) return new Response(Bun.file(join(root, 'src/web', url.pathname.slice(1))));
      return new Response('Not found', { status: 404 });
    },
  });
  return { server, statePath };
}

if (import.meta.main) {
  const { server, statePath } = await startPicker({ port: Number(process.env.PASEO_PORT ?? 4319), proxyOrigin: process.env.PASEO_URL });
  console.log(`Icon picker: ${process.env.PASEO_URL ?? server.url}\nPreferences: ${statePath}`);
  await new Promise<void>(resolve => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, resolve); });
  await server.stop();
}
