/** Self-contained so Folio can embed the same lifecycle without a second bundle. */
export function createReconnectLoop(options: {
  run: (signal: AbortSignal) => Promise<void>;
  onError: (error: unknown) => void;
  intervalMs?: number;
  retryMs?: number;
}) {
  const interval = options.intervalMs ?? 15_000;
  let delay = options.retryMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let controller: AbortController | undefined;
  let wakePending = false;
  let paused = false;
  let disposed = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (ms: number) => {
    clear();
    if (!paused && !disposed) timer = setTimeout(() => { void tick(); }, ms);
  };
  async function tick() {
    if (paused || disposed) return;
    if (running) { if (controller?.signal.aborted) wakePending = true; return; }
    clear();
    running = true;
    let next: number | null = interval;
    try {
      controller = new AbortController();
      await options.run(controller.signal);
      delay = options.retryMs ?? 500;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      next = status === 401 || status === 403 ? null : delay;
      delay = Math.min(Math.max(interval, 15_000), delay * 2);
      if (!disposed && !controller?.signal.aborted) options.onError(error);
    } finally {
      running = false;
      if (next !== null) schedule(wakePending ? 0 : next);
      wakePending = false;
    }
  }
  return {
    wake() { if (disposed) return; paused = false; void tick(); },
    pause() { paused = true; clear(); controller?.abort(); },
    dispose() { disposed = true; clear(); controller?.abort(); },
  };
}
