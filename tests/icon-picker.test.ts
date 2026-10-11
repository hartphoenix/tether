import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPicker } from '../scripts/icon-picker/server';

test('icon choices persist across restart; stale, invalid, and cross-origin writes are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tether-icons-'));
  const statePath = join(dir, 'selections.json');
  let picker = await startPicker({ port: 0, statePath });
  try {
    let origin = picker.server.url.origin;
    const initial = await (await fetch(`${origin}/api/bootstrap`)).json();
    expect(initial.catalog.length).toBeGreaterThan(30);
    expect(initial.themes.length).toBeGreaterThanOrEqual(11);
    const menuRows = initial.catalog.filter((row: { area: string }) => row.area === 'Folio menu');
    expect(menuRows).toHaveLength(7);
    for (const row of menuRows) { expect(row.phosphor).toBeNull(); expect(row.suggestions).toHaveLength(3); }
    const contextRows = initial.catalog.filter((row: { area: string }) => row.area === 'Folio right-click menu');
    const themeRows = initial.catalog.filter((row: { area: string }) => row.area === 'Theme menu');
    expect(contextRows).toHaveLength(12); expect(themeRows).toHaveLength(2);
    for (const row of [...contextRows, ...themeRows]) expect(row.suggestions).toHaveLength(3);
    const addedRows = [...menuRows, ...contextRows, ...themeRows];
    expect(initial.catalog.find((row: { id: string }) => row.id === 'archive').targets).toContain('#batch-move (active view / Archive action only)');
    for (const row of initial.catalog) for (const name of row.suggestions) expect((await fetch(`${origin}/icons/${name}.svg`)).status).toBe(200);
    const state = initial.state;
    state.rows.source.selected = 'code'; state.rows.source.candidates.push('heart'); state.scale = 1.5; state.theme = 'tether';
    const put = (body: unknown, from = origin) => fetch(`${origin}/api/state`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify(body) });
    expect((await put(state, 'https://example.com')).status).toBe(403);
    expect((await put(state)).status).toBe(200);
    expect((await put(state)).status).toBe(409);
    state.revision = 1; state.rows.source.selected = 'not-a-candidate';
    expect((await put(state)).status).toBe(400);
    expect((await Bun.file(statePath).json()).rows.source.selected).toBe('code');
    picker.server.stop(true);
    // Simulate a saved catalog from before the new menu rows existed.
    const oldSaved = await Bun.file(statePath).json();
    for (const row of addedRows) delete oldSaved.rows[row.id];
    oldSaved.rows.archive = { candidates: ['archive'], selected: 'archive', showCurrent: false, draft: 'box' };
    await Bun.write(statePath, JSON.stringify(oldSaved));
    picker = await startPicker({ port: 0, statePath }); origin = picker.server.url.origin;
    const restored = await (await fetch(`${origin}/api/state`)).json();
    expect(restored.rows.source.selected).toBe('code');
    expect(restored.rows.source.candidates).toContain('heart');
    expect(restored.scale).toBe(1.5); expect(restored.theme).toBe('tether');
    expect(restored.rows.archive).toEqual(oldSaved.rows.archive);
    expect(restored.revision).toBe(2);
    for (const row of addedRows) expect(restored.rows[row.id].candidates).toEqual(row.suggestions);
    expect(restored.rows['theme-inherit'].selected).toBe('layers-arrow-down');
    expect(restored.rows['theme-maker'].selected).toBe('layers-plus');
    expect((await put(oldSaved)).status).toBe(409);
    expect((await Bun.file(statePath).json()).controls.find((row: { id: string }) => row.id === 'archive').targets).toHaveLength(2);
  } finally { picker.server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
