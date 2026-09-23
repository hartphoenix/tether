/** Self-contained so Folio can embed the same lifecycle without a second bundle. */
export function createReconnectLoop(options: {
  run: () => Promise<void>;
  onError: (error: unknown) => void;
  intervalMs?: number;
  retryMs?: number;
}) {
  const interval = options.intervalMs ?? 15_000;
  let delay = options.retryMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let paused = false;
  let disposed = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (ms: number) => {
    clear();
    if (!paused && !disposed) timer = setTimeout(() => { void tick(); }, ms);
  };
  async function tick() {
    if (paused || disposed) return;
    if (running) return;
    clear();
    running = true;
    let next: number | null = interval;
    try {
      await options.run();
      delay = options.retryMs ?? 500;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      next = status === 401 || status === 403 ? null : delay;
      delay = Math.min(interval, delay * 2);
      if (!disposed) options.onError(error);
    } finally {
      running = false;
      if (next !== null) schedule(next);
    }
  }
  return {
    wake() { if (disposed) return; paused = false; void tick(); },
    pause() { paused = true; clear(); },
    dispose() { disposed = true; clear(); },
  };
}
