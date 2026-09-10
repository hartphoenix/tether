import { googleFontUrl, type ThemeFont } from '../shared/themes';

export function googleFontCandidates(input: string): { family: string; urls: string[] } {
  let family = input.trim();
  if (family.startsWith('https://fonts.googleapis.com/')) {
    const url = googleFontUrl(family);
    return { family: new URL(url).searchParams.get('family')!.split(':')[0], urls: [url] };
  }
  if (family.startsWith('https://fonts.google.com/')) {
    const url = new URL(family);
    if (!url.pathname.startsWith('/specimen/')) throw new Error('Paste a font family name, specimen link, or CSS2 stylesheet URL.');
    family = decodeURIComponent(url.pathname.slice('/specimen/'.length)).replaceAll('+', ' ');
  }
  if (!/^[\p{L}\p{N} -]{1,80}$/u.test(family)) throw new Error('Enter a font family name, such as Literata.');
  const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`;
  return { family, urls: [
    `${base}:ital,wght@0,400;0,700;1,400;1,700&display=swap`,
    `${base}:wght@400;700&display=swap`,
    `${base}&display=swap`,
  ] };
}

export function createFontLoader() {
  const links = new Map<string, { link: HTMLLinkElement; ready: Promise<void> }>();
  const load = (font: ThemeFont): Promise<void> => {
    if (!font.url) return Promise.resolve();
    const url = googleFontUrl(font.url);
    const existing = links.get(url);
    if (existing) return existing.ready;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = url; link.referrerPolicy = 'no-referrer'; link.crossOrigin = 'anonymous';
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Could not load ${font.family}. Check the connection or font styles.`)), 15000);
      const finish = (error?: Error) => {
        clearTimeout(timer); link.onload = link.onerror = null;
        if (error) { link.remove(); links.delete(url); reject(error); } else resolve();
      };
      link.onerror = () => finish(new Error(`Could not load ${font.family}. Check the connection or font styles.`));
      link.onload = () => {
        if (!document.fonts) { finish(); return; }
        void document.fonts.load(`16px "${font.family}"`).then(faces => finish(faces.length ? undefined : new Error(`No font face loaded for ${font.family}.`)), () => finish(new Error(`Could not download ${font.family}.`)));
      };
      document.head.append(link);
    });
    links.set(url, { link, ready });
    return ready;
  };
  return { load, destroy() { for (const { link } of links.values()) link.remove(); links.clear(); } };
}
