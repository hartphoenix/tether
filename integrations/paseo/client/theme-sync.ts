import type { PluginTheme } from '@getpaseo/plugin';
import { tetherThemes } from './themes';
import { sharedReaderSchema, type Intent } from '../shared/contracts';

declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
declare const crypto: { randomUUID(): string };
let clientId: string;
export function themeClientId(): string {
  if (clientId) return clientId;
  try { const saved = localStorage.getItem('tether.theme-client.v1'); if (saved && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved)) return clientId = saved; } catch {}
  clientId = crypto.randomUUID();
  try { localStorage.setItem('tether.theme-client.v1', clientId); } catch {}
  return clientId;
}

// Identify by three unmodified source colors; ambiguous palettes do not match.
const paletteMatches = [
  ...tetherThemes.map(t => [t.id, t.colors.background, t.colors.foreground, t.colors.accent!] as const),
  ['paseo-light', '#ffffff', '#1a1a1e', '#20744a'],
  ['paseo-dark', '#181b1a', '#fafafa', '#20744a'],
  ['paseo-zinc', '#18181b', '#fafafa', '#e4e4e7'],
  ['paseo-midnight', '#161820', '#fafafa', '#3b6fcf'],
  ['paseo-claude', '#1f1f1e', '#fafafa', '#d97757'],
  ['paseo-ghostty', '#282c34', '#fafafa', '#89b4fa'],
  ['paseo-pure-black', '#000000', '#fafafa', '#20744a'],
];
function normalize(color: string): string {
  const value = color.toLowerCase();
  return /^#[0-9a-f]{3}$/.test(value) ? '#' + [...value.slice(1)].map(c => c + c).join('') : value;
}
export function matchingTheme(theme: PluginTheme): string | null {
  const c = theme.colors;
  const matches = paletteMatches.filter(([, bg, fg, accent]) => normalize(c.surface0) === bg.toLowerCase() && normalize(c.foreground) === fg.toLowerCase() && normalize(c.accent) === accent.toLowerCase());
  return matches.length === 1 ? matches[0]![0]! : null;
}
export function themedLaunch(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/launch', '/recents/launch'].includes(url.pathname)) throw new Error('Invalid Tether launch');
  url.searchParams.set('themeClient', themeClientId());
  return url.href;
}

export function intentBrowserUrl(intent: Intent): string {
  if (!intent.sharedReader) return themedLaunch(intent.url);
  const reader = sharedReaderSchema.parse(intent.sharedReader);
  if (reader.url !== intent.url) throw new Error('Mismatched shared reader address');
  return `${reader.url}?themeClient=${themeClientId()}`;
}

const reports = new Map<string, { theme: string | null; promise: Promise<unknown>; settled: boolean }>();
export function reportTheme(connection: string, theme: string | null, send: () => Promise<unknown>, refresh = false): Promise<unknown> {
  const previous = reports.get(connection);
  if (previous?.theme === theme && (!refresh || !previous.settled)) return previous.promise;
  const promise = (previous?.promise.catch(() => {}) ?? Promise.resolve()).then(send);
  const report = { theme, promise, settled: false };
  reports.set(connection, report);
  void promise.then(() => { report.settled = true; }, () => { if (reports.get(connection) === report) reports.delete(connection); });
  return promise;
}
export function clearThemeReports(): void { reports.clear(); }
