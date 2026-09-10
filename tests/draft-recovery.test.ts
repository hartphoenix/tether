import { expect, test } from "bun:test";
import { DraftPersistence, recoverDraft, type DraftMutation, type DraftPayload } from "../src/web/draft-recovery";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("serializes POST and DELETE so a newer draft is not lost", async () => {
  const firstRequest = deferred();
  const calls: DraftMutation[] = [];
  const state: { stored: DraftPayload | null } = { stored: null };
  const persistence = new DraftPersistence(async (mutation) => {
    calls.push(mutation);
    if (calls.length === 1) await firstRequest.promise;
    state.stored = mutation.method === "POST" ? mutation.draft : null;
  });

  const oldWrite = persistence.update({
    editorMarkdown: "old edit", savedEditorMarkdown: "saved", body: "old edit", baseRevision: "rev-1", scroll: 1,
  });
  const undo = persistence.update({
    editorMarkdown: "saved", savedEditorMarkdown: "saved", body: "saved", baseRevision: "rev-1", scroll: 2,
  });
  const newerWrite = persistence.update({
    editorMarkdown: "newer edit", savedEditorMarkdown: "saved", body: "newer edit", baseRevision: "rev-1", scroll: 3,
  });

  await Promise.resolve();
  expect(calls.map(({ method }) => method)).toEqual(["POST"]);
  firstRequest.resolve();
  await Promise.all([oldWrite, undo, newerWrite]);

  expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE", "POST"]);
  expect(state.stored).toEqual({ body: "newer edit", baseRevision: "rev-1", scroll: 3 });
});

test("undoing to saved content and Reload both clear the recovery draft", async () => {
  const calls: DraftMutation[] = [];
  const persistence = new DraftPersistence(async (mutation) => { calls.push(mutation); });

  await persistence.update({
    editorMarkdown: "saved", savedEditorMarkdown: "saved", body: "saved", baseRevision: "rev-1", scroll: 0,
  });
  await persistence.clear();

  expect(calls).toEqual([{ method: "DELETE" }, { method: "DELETE" }]);
});

test("repeated conflicting recovery preserves the original base revision", () => {
  const document = { body: "disk version", bodyRevision: "rev-2" };
  const persisted = { body: "unsaved version", baseRevision: "rev-1", scroll: 24 };

  const firstRecovery = recoverDraft(document, persisted);
  expect(firstRecovery).toEqual({ ...persisted, conflicted: true });

  const rewrittenDraft = {
    body: firstRecovery!.body,
    baseRevision: firstRecovery!.baseRevision,
    scroll: firstRecovery!.scroll,
  };
  // Another observed disk-side revision (including one returned with an
  // annotation mutation) must not become the draft's save base.
  const secondRecovery = recoverDraft({ ...document, bodyRevision: "rev-3" }, rewrittenDraft);

  expect(secondRecovery?.baseRevision).toBe("rev-1");
  expect(secondRecovery?.conflicted).toBe(true);
});

test("a failed write does not block the next queued draft", async () => {
  const calls: DraftMutation[] = [];
  const persistence = new DraftPersistence(async (mutation) => {
    calls.push(mutation);
    if (calls.length === 1) throw new Error("offline");
  });

  await persistence.clear();
  await persistence.update({
    editorMarkdown: "new", savedEditorMarkdown: "saved", body: "new", baseRevision: "rev-1", scroll: 0,
  });

  expect(calls.map(({ method }) => method)).toEqual(["DELETE", "POST"]);
});
