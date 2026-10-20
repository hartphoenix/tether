import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Choice = { selected: boolean; comment: string };
type State = { version: 1; revision: number; icons: Record<string, Choice> };

export async function createGoPicker(directory: string, statePath: string) {
  const document = await readFile(join(directory, 'go-icons.md'), 'utf8');
  const shipped = new Set([...(document.split('## Shipped rotation')[1]?.split('\n## ')[0] ?? '').matchAll(/`([a-z0-9-]+)`/g)].map(match => match[1]));
  const catalog: { id: string; name: string; earlier: boolean; svg: string }[] = [];
  for (const folder of ['svg', 'svg-rejected']) {
    let files: string[];
    try { files = await readdir(join(directory, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files.sort()) {
      if (!/^[a-z0-9-]+\.svg$/.test(file)) continue;
      const name = file.slice(0, -4);
      catalog.push({ id: `${folder}/${name}`, name, earlier: folder === 'svg-rejected', svg: await readFile(join(directory, folder, file), 'utf8') });
    }
  }
  let state: State = { version: 1, revision: 0, icons: Object.fromEntries(catalog.map(icon => [icon.id, {
    selected: !icon.earlier && shipped.has(icon.name.replace(/^lucide-/, '')), comment: '',
  }])) };
  function validate(value: unknown): asserts value is State {
    const s = value as State;
    if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !s.icons ||
      typeof s.icons !== 'object' || Array.isArray(s.icons) || Object.keys(s.icons).length !== catalog.length) throw new Error('Invalid icon selections');
    for (const icon of catalog) {
      const choice = s.icons[icon.id];
      if (!choice || typeof choice.selected !== 'boolean' || typeof choice.comment !== 'string' || choice.comment.length > 2000) throw new Error(`Invalid choice for ${icon.name}`);
    }
  }
  async function persist(next: State) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, JSON.stringify(next, null, 2) + '\n');
    await rename(`${statePath}.tmp`, statePath);
  }
  try {
    const loaded = JSON.parse(await readFile(statePath, 'utf8'));
    if (!loaded.icons || typeof loaded.icons !== 'object' || Array.isArray(loaded.icons)) throw new Error('Invalid saved selections');
    const additions = catalog.filter(icon => !Object.hasOwn(loaded.icons, icon.id));
    for (const icon of additions) loaded.icons[icon.id] = state.icons[icon.id];
    validate(loaded); state = loaded;
    if (additions.length) { state.revision++; await persist(state); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await persist(state);
  }
  let writes = Promise.resolve();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  return async (request: Request) => {
    if (request.method === 'GET') return json({ catalog, state, statePath });
    if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('content-type') !== 'application/json' || request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Same-origin JSON required' }, 403);
    let answer!: Response;
    const work = writes.then(async () => {
      try {
        const proposed: unknown = await request.json();
        validate(proposed);
        if (proposed.revision !== state.revision) { answer = json({ error: 'Selections changed in another page. Reload before editing further.' }, 409); return; }
        const next: State = { version: 1, revision: state.revision + 1, icons: Object.fromEntries(catalog.map(icon => [icon.id, {
          selected: proposed.icons[icon.id]!.selected, comment: proposed.icons[icon.id]!.comment,
        }])) };
        await persist(next); state = next; answer = json({ revision: state.revision });
      } catch (error) { answer = json({ error: (error as Error).message }, 400); }
    });
    writes = work.catch(() => {}); await work; return answer;
  };
}
