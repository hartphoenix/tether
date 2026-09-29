import { expect, test } from 'bun:test';
import { chipRing, builtInDesign, builtInThemes, contrastRatio, preferencesFrom, storedPreferencesFrom, tetherDesign, updatePreferences, validateCustomTheme } from '../src/shared/themes';
import { googleFontCandidates } from '../src/web/theme-fonts';

const custom = (id: `custom-${string}` = 'custom-one', name = 'Slate') => ({ ...tetherDesign(true), id, name });
test('retired presets migrate while preserving custom designs and cannot be selected again', () => {
  for (const family of ['crepe', 'frame', 'nord']) for (const dark of [false, true]) {
    const retired = family + (dark ? '-dark' : '');
    const replacement = dark ? 'tether-dark' : 'tether';
    expect(preferencesFrom({ theme: retired }).theme).toBe(replacement);
    expect(() => updatePreferences(preferencesFrom(null), { theme: retired })).toThrow('Theme not found');
    const saved = { ...custom(), id: 'custom-one' as const, base: retired };
    const restored = preferencesFrom({ theme: saved.id, customThemes: [saved] });
    expect(restored.theme).toBe(saved.id);
    expect(restored.customThemes).toEqual([{ ...saved, base: replacement }]);
  }
});

test('Tether pairs share fonts and text, link, and inline code contrast exceeds 4.5:1', () => {
  expect(tetherDesign(true).fonts).toEqual(tetherDesign(false).fonts);
  for (const dark of [true, false]) {
    const c = tetherDesign(dark).colors;
    expect(contrastRatio(c['on-background'], c.background)).toBeGreaterThan(7);
    expect(contrastRatio(c.primary, c.background)).toBeGreaterThan(4.5);
    expect(contrastRatio(c['inline-code'], c['inline-area'])).toBeGreaterThan(4.5);
    expect(contrastRatio(c['on-surface-variant'], c.surface)).toBeGreaterThan(4.5);
  }
});
test('preferences migrate without replacing valid existing choices and recover corrupt entries', () => {
  expect(preferencesFrom(null)).toEqual({ fontSizingVersion: 1, theme: 'tether-dark', customThemes: [] });
  expect(preferencesFrom({ theme: 'tether' }).theme).toBe('tether');
  const p = preferencesFrom({ theme: 'custom-one', customThemes: [{ nonsense: true }, custom()] });
  expect(p.theme).toBe('custom-one'); expect(p.customThemes).toHaveLength(1);
  expect(preferencesFrom({ theme: 'custom-missing' }).theme).toBe('tether-dark');
});
test('library operations retain other themes, reject collisions and protect built-ins', () => {
  let p = updatePreferences(preferencesFrom(null), { saveTheme: custom(), theme: 'custom-one' });
  p = updatePreferences(p, { saveTheme: custom('custom-two', 'Paper') });
  p = updatePreferences(p, { theme: 'tether' });
  expect(p.customThemes).toHaveLength(2);
  expect(() => updatePreferences(p, { saveTheme: custom('custom-three', 'slate') })).toThrow('already in use');
  expect(() => updatePreferences(p, { saveTheme: custom('custom-three', 'Tether Dark') })).toThrow('already in use');
  expect(() => updatePreferences(p, { deleteTheme: 'tether' })).toThrow();
  p = updatePreferences(p, { theme: 'custom-one' });
  p = updatePreferences(p, { deleteTheme: 'custom-one' });
  expect(p.theme).toBe('tether-dark'); expect(p.customThemes[0].name).toBe('Paper');
});
test('theme validation disallows executable CSS, arbitrary remote URLs and unbounded dimensions', () => {
  const raw = custom();
  expect(() => validateCustomTheme({ ...raw, colors: { ...raw.colors, background: 'url(https://example.com)' } })).toThrow();
  expect(() => validateCustomTheme({ ...raw, metrics: { ...raw.metrics, bodySize: 999 } })).toThrow();
  expect(() => validateCustomTheme({ ...raw, fonts: { ...raw.fonts, body: { family: 'Bad"; }', fallback: 'serif' } } })).toThrow();
  for (const url of ['https://example.com/a.css', 'https://fonts.googleapis.com/css2?family=Literata&text=private', 'https://fonts.googleapis.com/css2?family=Literata&family=Inter']) {
    expect(() => validateCustomTheme({ ...raw, fonts: { ...raw.fonts, body: { family: 'Literata', fallback: 'serif', url } } })).toThrow();
  }
  expect(validateCustomTheme({ ...raw, fonts: { ...raw.fonts, body: { family: 'Literata', fallback: 'serif', url: 'https://fonts.googleapis.com/css2?family=Literata:wght@200..900' } } }).fonts.body.url).toContain('display=swap');
});
test('font imports accept names, specimen links and a single-family variable CSS2 URL', () => {
  expect(googleFontCandidates('Source Sans 3').family).toBe('Source Sans 3');
  expect(googleFontCandidates('https://fonts.google.com/specimen/Source+Serif+4').family).toBe('Source Serif 4');
  const result = googleFontCandidates('https://fonts.googleapis.com/css2?family=Literata:ital,wght@0,200..900;1,200..900&display=swap');
  expect(result.family).toBe('Literata'); expect(result.urls).toHaveLength(1);
  expect(() => googleFontCandidates('https://example.com/font.css')).toThrow();
});

// These are reading palettes: subdued text must stay legible even on selection fills.
test('Paseo palettes preserve readable text, accents, and controls across their surfaces', () => {
  const themes = builtInThemes.filter(theme => theme.value.startsWith('paseo-'));
  expect(themes).toHaveLength(7);
  for (const { value, label } of themes) {
    const design = builtInDesign(value)!;
    const c = design.colors;
    expect(preferencesFrom({ theme: value }).theme).toBe(value);
    expect(validateCustomTheme({ ...design, id: 'custom-paseo-copy', name: 'Copy' }).colors).toEqual(c);
    expect(contrastRatio(c['on-background'], c.background), label).toBeGreaterThanOrEqual(7);
    for (const background of [c.background, c.surface, c['surface-low'], c.secondary, c.selected, c.hover, c['inline-area']]) {
      for (const text of [c['on-background'], c['on-surface'], c['on-surface-variant'], c.primary, c['inline-code'], c.error]) {
        expect(contrastRatio(text, background), `${label}: ${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(c['on-secondary'], c.secondary), label).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c['on-inverse'], c.inverse), label).toBeGreaterThanOrEqual(4.5);
    for (const background of [c.background, c.surface, c['surface-low']]) {
      expect(contrastRatio(c.outline, background), label).toBeGreaterThanOrEqual(3);
    }
  }
});

test('appearance preferences survive theme edits and reject invalid mutations', () => {
  const value = preferencesFrom({ uiScale: 1.25, railWidth: 450 });
  expect(updatePreferences(value, { theme: 'tether' })).toMatchObject({ uiScale: 1.25, railWidth: 450 });
  expect(preferencesFrom({ uiScale: 8, railWidth: '300' })).toEqual(preferencesFrom(null));
  for (const uiScale of [0.69, 1.51, NaN, '1']) expect(() => updatePreferences(value, { uiScale })).toThrow();
  for (const railWidth of [227, 641, Infinity]) expect(() => updatePreferences(value, { railWidth })).toThrow();
});

test('chip rings and incoming banner maintain preset contrast', () => {
  const mix = (a: string, b: string, weight: number) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * weight + parseInt(b.slice(i, i + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
  for (const { value: id } of builtInThemes) {
    const c = builtInDesign(id)!.colors;
    for (const dot of [c.annotation, c.selected]) expect(contrastRatio(chipRing(c, dot), dot)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c['on-background'], mix(c.annotation, c.background, .18))).toBeGreaterThanOrEqual(4.5);
  }
});


test('stored legacy font sizes convert once before validation; new selections remain exact', () => {
  const legacy = custom();
  legacy.metrics = { ...legacy.metrics, headingSize: 22, bodySize: 14, codeSize: 11 };
  const migrated = storedPreferencesFrom({ theme: legacy.id, customThemes: [legacy], defaultDocumentZoom: 115, uiScale: 1.2 });
  expect(migrated).toMatchObject({ fontSizingVersion: 1, theme: legacy.id, defaultDocumentZoom: 115, uiScale: 1.2 });
  expect(migrated.customThemes[0]).toEqual({ ...legacy, metrics: { ...legacy.metrics, headingSize: 17.6, bodySize: 11.2, codeSize: 8.8 } });
  expect(storedPreferencesFrom(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
  const edited = { ...migrated.customThemes[0], metrics: { ...migrated.customThemes[0].metrics, bodySize: 14 * 4 / 3 } };
  const saved = updatePreferences(migrated, { saveTheme: edited });
  expect(storedPreferencesFrom(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  expect(saved.customThemes[0].metrics.bodySize).toBe(18 + 2 / 3);
});
