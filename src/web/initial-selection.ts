import { Selection, type EditorStateConfig } from "@milkdown/kit/prose/state";
import { GapCursor } from "@milkdown/kit/prose/gapcursor";

/** Give the unfocused reader an empty internal selection, without selecting document content. */
export function initialReaderSelection(options: EditorStateConfig): EditorStateConfig {
  if (options.selection || !options.doc) return options;
  const start = options.doc.resolve(0);
  // Crepe already supports gap cursors before atom-only content. Like text cursors,
  // these remain invisible until focus; no paragraph needs to be inserted at startup.
  const selection = Selection.findFrom(start, 1, true) ?? new GapCursor(start);
  return { ...options, selection };
}
