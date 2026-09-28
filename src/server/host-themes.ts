import { readFile, writeFile, rename } from 'node:fs/promises';
import { builtInDesign, isBuiltInTheme, type BuiltInTheme, type ThemeId, type ThemePreferences } from '../shared/themes';

type Entry = { enabled: boolean; theme?: ThemeId; detected: BuiltInTheme | null };
export const isThemeClient = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Per desktop-client appearance; never replaces the profile's normal theme. */
export class HostThemes {
  private entries: Record<string, Entry> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void>;
  constructor(private path: string, private changed: () => void) {
    this.loaded = readFile(path, 'utf8').then(raw => {
      const data = JSON.parse(raw);
      for (const [id, value] of Object.entries(data).slice(0, 128)) {
        const e = value as Entry;
        if (isThemeClient(id) && e && typeof e.enabled === 'boolean' && (e.detected === null || isBuiltInTheme(e.detected))) this.entries[id] = e;
      }
    }).catch(() => {});
  }
  async preferences(id: string | undefined, base: ThemePreferences): Promise<ThemePreferences> {
    await this.loaded;
    if (!id) return base;
    const entry = this.entries[id];
    const theme = entry?.theme;
    return { ...base, theme: theme && (builtInDesign(theme) || base.customThemes.some(t => t.id === theme)) ? theme : base.theme, inheritPaseoTheme: entry?.enabled ?? false };
  }
  private update(id: string, change: (entry: Entry) => Entry): Promise<void> {
    if (!isThemeClient(id)) return Promise.reject(new Error('Invalid theme client'));
    const next = this.queue.then(async () => {
      await this.loaded;
      const previous = this.entries[id];
      if (!previous && Object.keys(this.entries).length >= 128) throw new Error('Theme client limit reached');
      const entry = change(previous ?? { enabled: false, detected: null });
      if (JSON.stringify(entry) === JSON.stringify(previous)) return;
      const entries = { ...this.entries, [id]: entry };
      const temp = this.path + '.tmp';
      await writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
      await rename(temp, this.path);
      this.entries = entries;
      this.changed();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  observe(id: string, theme: unknown): Promise<void> {
    if (theme !== null && !isBuiltInTheme(theme)) return Promise.reject(new Error('Unknown host theme'));
    return this.update(id, entry => ({ ...entry, detected: theme, ...(entry.enabled && theme ? { theme } : {}) }));
  }
  select(id: string, selection: { inheritPaseoTheme?: boolean; theme?: ThemeId }, base: ThemePreferences): Promise<void> {
    return this.update(id, entry => {
      if (selection.inheritPaseoTheme === true) return { ...entry, enabled: true, theme: entry.detected ?? entry.theme ?? base.theme };
      if (selection.theme) return { ...entry, enabled: false, theme: selection.theme };
      return { ...entry, enabled: false, theme: entry.theme ?? base.theme };
    });
  }
}
