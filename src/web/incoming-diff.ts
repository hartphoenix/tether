import type { Editor } from "@milkdown/kit/core";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  clearDiffReviewCmd,
  diff,
  diffPluginKey,
  startDiffReviewCmd,
} from "@milkdown/kit/plugin/diff";
import { diffComponent } from "@milkdown/components/diff";

export const incomingDiffPlugins = [...diff, ...diffComponent];

export function startIncomingDiff(editor: Editor, markdown: string): boolean {
  let started = false;
  editor.action((ctx) => {
    started = ctx.get(commandsCtx).call(startDiffReviewCmd.key, markdown);
  });
  return started;
}

export function incomingDiffActive(editor: Editor): boolean {
  let active = false;
  editor.action((ctx) => {
    active = Boolean(diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active);
  });
  return active;
}

export function cancelIncomingDiff(editor: Editor): boolean {
  let cleared = false;
  editor.action((ctx) => {
    cleared = ctx.get(commandsCtx).call(clearDiffReviewCmd.key);
  });
  return cleared;
}
