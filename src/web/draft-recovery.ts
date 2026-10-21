export type DraftPayload = {
  body: string;
  baseRevision: string;
  scroll: number;
};

export type DraftMutation =
  | { method: "POST"; draft: DraftPayload }
  | { method: "DELETE" };

type DraftUpdate = DraftPayload & {
  scope?: string;
  editorMarkdown: string;
  savedEditorMarkdown: string;
};

export class DraftPersistence {
  private persisted: string | undefined;
  private running = false;
  private pending?: { mutation: DraftMutation; key: string; force: boolean; waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> };

  constructor(private readonly send: (mutation: DraftMutation) => Promise<void>) {}

  update(update: DraftUpdate, strict = false): Promise<void> {
    const mutation: DraftMutation = update.editorMarkdown === update.savedEditorMarkdown
      ? { method: "DELETE" }
      : { method: "POST", draft: { body: update.body, baseRevision: update.baseRevision, scroll: update.scroll } };
    return this.enqueue(mutation, JSON.stringify([update.scope, mutation]), strict);
  }

  clear(): Promise<void> {
    // Explicit reload/save cleanup must also remove drafts from another view.
    return this.enqueue({ method: "DELETE" }, "clear", false, true);
  }

  private enqueue(mutation: DraftMutation, key: string, strict: boolean, force = false): Promise<void> {
    const write = new Promise<void>((resolve, reject) => {
      const waiters = this.pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      this.pending = { mutation, key, force, waiters };
    });
    void this.drain();
    return strict ? write : write.catch(() => {});
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        try {
          if (next.force || next.key !== this.persisted) {
            await this.send(next.mutation);
            this.persisted = next.key;
          }
          for (const waiter of next.waiters) waiter.resolve();
        } catch (error) {
          // A failed/ambiguous write cannot establish server state.
          this.persisted = undefined;
          for (const waiter of next.waiters) waiter.reject(error);
        }
      }
    } finally { this.running = false; }
  }
}

export type RecoveredDraft = DraftPayload & { conflicted: boolean };

export function recoverDraft(
  document: { body: string; bodyRevision: string },
  draft?: DraftPayload | null,
): RecoveredDraft | null {
  if (!draft || draft.body === document.body) return null;
  return {
    body: draft.body,
    baseRevision: draft.baseRevision,
    scroll: draft.scroll,
    conflicted: draft.baseRevision !== document.bodyRevision,
  };
}
