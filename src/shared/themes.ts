import { themePresets } from './theme-presets';

export const builtInThemes = [
  { value: 'tether', label: 'Tether Light' },
  { value: 'tether-dark', label: 'Tether Dark' },
  { value: 'light-treason', label: 'Light Treason' },
  { value: 'dark-academia', label: 'Dark Academia' },
  { value: 'frame', label: 'Frame Light' }, { value: 'frame-dark', label: 'Frame Dark' },
  { value: 'crepe', label: 'Crepe Light' }, { value: 'crepe-dark', label: 'Crepe Dark' },
  { value: 'nord', label: 'Nord Light' }, { value: 'nord-dark', label: 'Nord Dark' },
] as const;
export type BuiltInTheme = typeof builtInThemes[number]['value'];
export type ThemeId = BuiltInTheme | `custom-${string}`;
export const colorKeys = ['background', 'on-background', 'surface', 'surface-low', 'on-surface', 'on-surface-variant', 'outline', 'primary', 'secondary', 'on-secondary', 'inverse', 'on-inverse', 'inline-code', 'error', 'hover', 'selected', 'inline-area', 'annotation'] as const;
export const annotationColor = (dark: boolean): string => dark ? '#ffbe3e' : '#f1be5c';
export type ThemeColors = Record<typeof colorKeys[number], string>;
export const fontSlots = ['heading', 'body', 'code'] as const;
export type FontSlot = typeof fontSlots[number];
export type ThemeFont = { family: string; fallback: 'serif' | 'sans-serif' | 'monospace'; url?: string };
export const bundledFonts: ThemeFont[] = [
  { family: 'Hanken Grotesk', fallback: 'sans-serif' },
  { family: 'Cabin', fallback: 'sans-serif' },
  { family: 'Alegreya', fallback: 'serif' },
  { family: 'Source Serif 4', fallback: 'serif' },
  { family: 'Source Sans 3', fallback: 'sans-serif' },
  { family: 'DM Mono', fallback: 'monospace' },
  { family: 'Georgia', fallback: 'serif' },
  { family: 'Arial', fallback: 'sans-serif' },
  { family: 'Menlo', fallback: 'monospace' },
];
// Bounds are shared by controls and persisted-data validation.
export const metrics = {
  headingSize: { label: 'Heading size', min: 22, max: 64, step: 1, unit: 'px' },
  headingWeight: { label: 'Heading weight', min: 300, max: 900, step: 10, unit: '' },
  headingSpacing: { label: 'Heading tracking', min: -0.04, max: 0.08, step: 0.002, unit: 'em' },
  bodySize: { label: 'Paragraph size', min: 14, max: 28, step: 0.5, unit: 'px' },
  bodyWeight: { label: 'Paragraph weight', min: 300, max: 650, step: 10, unit: '' },
  bodySpacing: { label: 'Paragraph tracking', min: -0.02, max: 0.06, step: 0.002, unit: 'em' },
  lineHeight: { label: 'Line spacing', min: 1.2, max: 2.2, step: 0.05, unit: '×' },
  paragraphGap: { label: 'Paragraph gap', min: 0, max: 2, step: 0.05, unit: 'em' },
  lineWidth: { label: 'Reading width', min: 40, max: 100, step: 1, unit: 'ch' },
  codeSize: { label: 'Code size', min: 11, max: 24, step: 0.5, unit: 'px' },
  codeWeight: { label: 'Code weight', min: 300, max: 700, step: 10, unit: '' },
  codeLineHeight: { label: 'Code line spacing', min: 1.2, max: 2, step: 0.05, unit: '×' },
} as const;
export type Metric = keyof typeof metrics;
export type ThemeDesign = {
  base: BuiltInTheme;
  colors: ThemeColors;
  fonts: Record<FontSlot, ThemeFont>;
  metrics: Record<Metric, number>;
};
export type CustomTheme = ThemeDesign & { id: `custom-${string}`; name: string };
export type ThemePreferences = { theme: ThemeId; customThemes: CustomTheme[] };
export type ThemeMutation = { theme?: ThemeId; saveTheme?: CustomTheme; deleteTheme?: string };

export function isBuiltInTheme(value: unknown): value is BuiltInTheme {
  return builtInThemes.some(t => t.value === value);
}
export function googleFontUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://fonts.googleapis.com' || url.pathname !== '/css2' || url.username || url.password || url.hash || value.length > 2000) throw new Error('Use a Google Fonts CSS2 stylesheet URL.');
  if ([...url.searchParams.keys()].some(k => !['family', 'display'].includes(k)) || url.searchParams.getAll('family').length !== 1) throw new Error('Import one font family at a time, without text subsetting.');
  const family = url.searchParams.get('family')!;
  if (!/^[\p{L}\p{N} -]+(?::[a-zA-Z0-9,@;. -]+)?$/u.test(family)) throw new Error('Invalid Google Fonts family.');
  url.searchParams.set('display', 'swap');
  return url.href;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid theme data.');
  return value as Record<string, unknown>;
}
export function validateCustomTheme(value: unknown): CustomTheme {
  const raw = object(value);
  if (typeof raw.id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,80}$/.test(raw.id)) throw new Error('Invalid theme ID.');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 64) throw new Error('Theme names must contain 1–64 characters.');
  if (!isBuiltInTheme(raw.base)) throw new Error('Invalid template theme.');
  const colors = object(raw.colors), fonts = object(raw.fonts), values = object(raw.metrics);
  const result = { id: raw.id, name: raw.name.trim(), base: raw.base, colors: {}, fonts: {}, metrics: {} } as CustomTheme;
  for (const key of colorKeys) {
    if (key === 'annotation' && colors[key] === undefined) {
      result.colors[key] = annotationColor(raw.base.endsWith('-dark'));
      continue;
    }
    if (typeof colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(colors[key] as string)) throw new Error(`Invalid color: ${key}`);
    result.colors[key] = colors[key] as string;
  }
  for (const slot of fontSlots) {
    const font = object(fonts[slot]);
    if (typeof font.family !== 'string' || !/^[\p{L}\p{N} -]{1,80}$/u.test(font.family) || !['serif', 'sans-serif', 'monospace'].includes(font.fallback as string)) throw new Error('Invalid font family.');
    const url = font.url === undefined ? undefined : googleFontUrl(String(font.url));
    if (url && new URL(url).searchParams.get('family')!.split(':')[0] !== font.family) throw new Error('Font family must match the stylesheet.');
    result.fonts[slot] = { family: font.family, fallback: font.fallback as ThemeFont['fallback'], ...(url ? { url } : {}) };
  }
  for (const key of Object.keys(metrics) as Metric[]) {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < metrics[key].min || value > metrics[key].max) throw new Error(`Invalid ${metrics[key].label.toLowerCase()}.`);
    result.metrics[key] = value;
  }
  return result;
}
export function preferencesFrom(value: unknown): ThemePreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const customThemes: CustomTheme[] = [];
  if (Array.isArray(raw.customThemes)) for (const item of raw.customThemes.slice(0, 100)) {
    try { const theme = validateCustomTheme(item); if (!customThemes.some(t => t.id === theme.id)) customThemes.push(theme); } catch { /* Ignore corrupt entries, preserving valid themes. */ }
  }
  const theme = isBuiltInTheme(raw.theme) || customThemes.some(t => t.id === raw.theme) ? raw.theme as ThemeId : 'tether-dark';
  return { theme, customThemes };
}
export function updatePreferences(current: ThemePreferences, value: unknown): ThemePreferences {
  const raw = object(value);
  let customThemes = [...current.customThemes];
  if (raw.saveTheme !== undefined) {
    const saved = validateCustomTheme(raw.saveTheme);
    if (customThemes.some(t => t.id !== saved.id && t.name.toLocaleLowerCase() === saved.name.toLocaleLowerCase()) || builtInThemes.some(t => t.label.toLocaleLowerCase() === saved.name.toLocaleLowerCase())) throw new Error('That theme name is already in use.');
    customThemes = [...customThemes.filter(t => t.id !== saved.id), saved];
    if (customThemes.length > 100) throw new Error('The theme library is full (100 themes).');
  }
  if (raw.deleteTheme !== undefined) {
    if (typeof raw.deleteTheme !== 'string' || !customThemes.some(t => t.id === raw.deleteTheme)) throw new Error('Custom theme not found.');
    customThemes = customThemes.filter(t => t.id !== raw.deleteTheme);
  }
  const theme = raw.theme ?? (current.theme === raw.deleteTheme ? 'tether-dark' : current.theme);
  if (!isBuiltInTheme(theme) && !customThemes.some(t => t.id === theme)) throw new Error('Theme not found.');
  return { theme: theme as ThemeId, customThemes };
}
export function builtInDesign(id: ThemeId): ThemeDesign | undefined {
  if (!Object.hasOwn(themePresets, id)) return undefined;
  return structuredClone(themePresets[id as keyof typeof themePresets]);
}
export function tetherDesign(dark: boolean): ThemeDesign {
  return builtInDesign(dark ? 'tether-dark' : 'tether')!;
}
export function contrastRatio(a: string, b: string): number {
  const luminance = (color: string) => {
    const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
