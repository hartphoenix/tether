/** Short requests cannot exhaust the browser's per-origin HTTP/1 connection pool.
 * Self-contained for embedding in Folio's standalone HTML. */
export function pollPreferences(url: string, apply: (value: any) => void): () => void {
  let disposed = false, paused = false, running = false, last = '', delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const tick = async () => {
    if (disposed || paused || running) return;
    clearTimeout(timer); running = true;
    request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), 5000);
    try {
      const response = await fetch(url, { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error('Preferences unavailable'), { status: response.status });
      const value = await response.json(), serialized = JSON.stringify(value);
      if (!disposed && !paused && serialized !== last) { apply(value); last = serialized; }
      delay = 500;
    } catch (error) {
      if ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403) paused = true;
      delay = Math.min(15000, delay * 2);
    } finally {
      clearTimeout(timeout); running = false;
      if (!disposed && !paused) timer = setTimeout(tick, document.hidden ? 5000 : delay);
    }
  };
  const wake = () => { paused = false; void tick(); };
  const pause = () => { paused = true; clearTimeout(timer); request?.abort(); };
  const visibility = () => { if (!document.hidden) wake(); };
  addEventListener('pageshow', wake); addEventListener('online', wake);
  addEventListener('pagehide', pause); document.addEventListener('visibilitychange', visibility);
  void tick();
  return () => { disposed = true; pause(); removeEventListener('pageshow', wake); removeEventListener('online', wake); removeEventListener('pagehide', pause); document.removeEventListener('visibilitychange', visibility); };
}
