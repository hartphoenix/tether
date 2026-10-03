export function scrollToDocumentAnchor(root: HTMLElement, hash: string, smooth = true): boolean {
  if (!hash.startsWith('#') || hash.length < 2) return false;
  let id: string;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return false; }
  const target = [...root.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === id);
  if (!target) return false;
  target.scrollIntoView({ block: 'start', behavior: smooth && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  return true;
}
