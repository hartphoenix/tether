/**
 * Serializes complete read/validate/write transactions by canonical real path.
 * A queue entry is kept until its operation has released the path, including
 * when the operation rejects.
 */
export type QueueOperation<T> = () => Promise<T> | T;

type QueueEntry = {
  tail: Promise<void>;
  release: () => void;
};

export class RealPathMutationQueue {
  private readonly entries = new Map<string, QueueEntry>();

  async run<T>(realPath: string, operation: QueueOperation<T>): Promise<T> {
    const previous = this.entries.get(realPath)?.tail ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.entries.set(realPath, { tail, release });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.entries.get(realPath)?.tail === tail) this.entries.delete(realPath);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const MutationQueue = RealPathMutationQueue;
