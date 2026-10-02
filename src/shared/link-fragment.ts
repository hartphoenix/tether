/** Preserve an authored fragment across file resolution and launch redirects. */
export function linkFragment(target: string, format: 'markdown' | 'wikilink' = 'markdown'): string {
  const path = format === 'wikilink' ? target.split('|', 1)[0]! : target;
  const hash = path.indexOf('#');
  if (hash < 0) return '';
  const fragment = path.slice(hash + 1);
  try { return '#' + encodeURIComponent(decodeURIComponent(fragment)); }
  catch { return '#' + encodeURIComponent(fragment); }
}
