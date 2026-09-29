import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostThemes } from '../src/server/host-themes';
import { preferencesFrom } from '../src/shared/themes';
import { matchingTheme, reportTheme, clearThemeReports } from '../integrations/paseo/client/theme-sync';
import { tetherThemes } from '../integrations/paseo/client/themes';
type PluginTheme = Parameters<typeof matchingTheme>[0];

test('host themes retain unknown matches, persist last theme, and isolate clients and normal hosts', async () => {
  const dir = await mkdtemp('/tmp/tether-host-themes-');
  const id = crypto.randomUUID(), other = crypto.randomUUID(), base = preferencesFrom(null);
  const path = join(dir, 'themes.json');
  try {
    const store = new HostThemes(path, () => {});
    await store.observe(id, 'paseo-claude');
    expect((await store.preferences(id, base)).theme).toBe(base.theme);
    await store.select(id, { inheritPaseoTheme: true }, base);
    expect((await store.preferences(id, base)).theme).toBe('paseo-claude');
    await store.observe(id, null);
    expect(await store.preferences(id, base)).toMatchObject({ inheritPaseoTheme: true, theme: 'paseo-claude' });
    expect(await store.preferences(undefined, base)).toEqual(base);
    expect((await store.preferences(other, base)).theme).toBe(base.theme);
    await store.observe(id, 'light-treason');
    expect((await store.preferences(id, base)).theme).toBe('light-treason');
    await store.select(id, { theme: 'dark-academia' }, base);
    await store.observe(id, 'paseo-light');
    expect(await store.preferences(id, base)).toMatchObject({ inheritPaseoTheme: false, theme: 'dark-academia' });
    expect(await new HostThemes(path, () => {}).preferences(id, base)).toMatchObject({ theme: 'dark-academia' });
    await expect(store.observe(id, 'custom-injected')).rejects.toThrow();
    await expect(store.observe('../escape', 'tether')).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recognizes Tether palettes and Paseo source colors without matching unknown colors', () => {
  for (const t of tetherThemes) {
    const colors = { surface0: t.colors.background.toUpperCase(), foreground: t.colors.foreground, accent: t.colors.accent } as PluginTheme['colors'];
    expect(matchingTheme({ colors })).toBe(t.id);
  }
  expect(matchingTheme({ colors: { surface0: '#FFF', foreground: '#1a1a1e', accent: '#20744A' } as PluginTheme['colors'] })).toBe('paseo-light');
  expect(matchingTheme({ colors: { surface0: '#abcdef', foreground: '#fff', accent: '#123456' } as PluginTheme['colors'] })).toBeNull();
});

test('theme reports deduplicate mounts, serialize changes, and retry failures', async () => {
  clearThemeReports();
  let calls = 0;
  const send = async () => { calls++; };
  await Promise.all([reportTheme('a', 'tether', send), reportTheme('a', 'tether', send)]);
  expect(calls).toBe(1);
  await reportTheme('a', null, send); expect(calls).toBe(2);
  await expect(reportTheme('b', null, async () => { throw new Error('offline'); })).rejects.toThrow();
  await reportTheme('b', null, send); expect(calls).toBe(3);
  clearThemeReports();
});


test('a fresh reporting mount reasserts a delivered theme but shares in-flight work', async () => {
  clearThemeReports();
  const sent: string[] = [];
  await reportTheme('client-host-profile', 'tether', async () => { sent.push('first'); });
  const refresh = () => reportTheme('client-host-profile', 'tether', async () => { sent.push('remount'); }, true);
  await Promise.all([refresh(), refresh()]);
  expect(sent).toEqual(['first', 'remount']);
  await reportTheme('other-client', 'tether', async () => { sent.push('other'); }, true);
  expect(sent).toEqual(['first', 'remount', 'other']);
});
