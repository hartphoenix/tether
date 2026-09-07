import { expect, test } from 'bun:test';
import { contrastRatio, preferencesFrom, tetherDesign, updatePreferences, validateCustomTheme } from '../src/shared/themes';
import { googleFontCandidates } from '../src/web/theme-fonts';

const custom = (id = 'custom-one', name = 'Slate') => ({ ...tetherDesign(true), id, name });
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
  expect(preferencesFrom(null)).toEqual({ theme: 'tether-dark', customThemes: [] });
  expect(preferencesFrom({ theme: 'nord' }).theme).toBe('nord');
  const p = preferencesFrom({ theme: 'custom-one', customThemes: [{ nonsense: true }, custom()] });
  expect(p.theme).toBe('custom-one'); expect(p.customThemes).toHaveLength(1);
  expect(preferencesFrom({ theme: 'custom-missing' }).theme).toBe('tether-dark');
});
test('library operations retain other themes, reject collisions and protect built-ins', () => {
  let p = updatePreferences(preferencesFrom(null), { saveTheme: custom(), theme: 'custom-one' });
  p = updatePreferences(p, { saveTheme: custom('custom-two', 'Paper') });
  p = updatePreferences(p, { theme: 'crepe' });
  expect(p.customThemes).toHaveLength(2);
  expect(() => updatePreferences(p, { saveTheme: custom('custom-three', 'slate') })).toThrow('already in use');
  expect(() => updatePreferences(p, { saveTheme: custom('custom-three', 'Tether Dark') })).toThrow('already in use');
  expect(() => updatePreferences(p, { deleteTheme: 'crepe' })).toThrow();
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
