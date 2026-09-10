export type DraftPayload = {
  body: string;
  baseRevision: string;
  scroll: number;
};

export type DraftMutation =
  | { method: "POST"; draft: DraftPayload }
  | { method: "DELETE" };

type DraftUpdate = DraftPayload & {
  editorMarkdown: string;
  savedEditorMarkdown: string;
};

export class DraftPersistence {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly send: (mutation: DraftMutation) => Promise<void>) {}

  update(update: DraftUpdate): Promise<void> {
    return this.enqueue(update.editorMarkdown === update.savedEditorMarkdown
      ? { method: "DELETE" }
      : {
          method: "POST",
          draft: { body: update.body, baseRevision: update.baseRevision, scroll: update.scroll },
        });
  }

  clear(): Promise<void> {
    return this.enqueue({ method: "DELETE" });
  }

  private enqueue(mutation: DraftMutation): Promise<void> {
    const write = this.writes.then(() => this.send(mutation));
    // A failed request must not prevent later recovery writes from running.
    this.writes = write.catch(() => {});
    return this.writes;
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
