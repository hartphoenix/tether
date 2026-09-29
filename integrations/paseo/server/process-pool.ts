import { TetherError } from "./errors";

type Waiting = { grant: () => void; cancel: () => void };

/** Shared across connection replacements; a long poll cannot occupy interactive capacity. */
export class ProcessPool {
  private active = [0, 0];
  private queues: Waiting[][] = [[], []];
  constructor(private readonly limits = [1, 3], private readonly maxQueued = 32) {}

  acquire(wait: boolean, signal: AbortSignal): Promise<() => void> {
    const lane = wait ? 0 : 1;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new TetherError("tether_cancelled", "Tether connection changed.")); return; }
      const queue = this.queues[lane]!;
      const cancel = () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener("abort", cancel);
        reject(new TetherError("tether_cancelled", "Tether connection changed."));
      };
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        this.active[lane]! += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active[lane]! -= 1;
          queue.shift()?.grant();
        });
      };
      const item = { grant, cancel };
      if (this.active[lane]! < this.limits[lane]!) grant();
      else if (this.queues.reduce((sum, items) => sum + items.length, 0) >= this.maxQueued) reject(new TetherError("tether_busy", "Tether is busy. Try again shortly."));
      else { queue.push(item); signal.addEventListener("abort", cancel, { once: true }); }
    });
  }
}
