import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { liftTarget } from "@milkdown/kit/prose/transform";
import type { Command, Selection } from "@milkdown/kit/prose/state";

export type CommandResult = { ok: true } | { ok: false; reason: string };
const ok = (): CommandResult => ({ ok: true });
const fail = (reason: string): CommandResult => ({ ok: false, reason });

function ancestorHas($pos: Selection["$from"], typeName: string): boolean {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.name === typeName) return true;
  }
  return false;
}

function selectionContainsNodeType(selection: Selection, typeName: string): boolean {
  let found = false;
  if (selection.from >= selection.to) return false;
  selection.$from.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === typeName) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function definitionsAndReferences(doc: ProseMirrorNode): {
  definitions: { node: ProseMirrorNode; from: number }[];
  references: { node: ProseMirrorNode; from: number }[];
} {
  const definitions: { node: ProseMirrorNode; from: number }[] = [];
  const references: { node: ProseMirrorNode; from: number }[] = [];
  doc.nodesBetween(0, doc.content.size, (node, from) => {
    if (node.type.name === "footnote_definition") definitions.push({ node, from });
    else if (node.type.name === "footnote_reference") references.push({ node, from });
    return true;
  });
  return { definitions, references };
}

function reviewLabel(node: ProseMirrorNode): string {
  const label = node.attrs.label;
  return typeof label === "string" ? label : "";
}

function normalizedLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function allocateReviewLabel(doc: ProseMirrorNode): string {
  const used = new Set<string>();
  const usedNumbers = new Set<number>();
  const { definitions, references } = definitionsAndReferences(doc);
  for (const { node } of [...definitions, ...references]) {
    const label = normalizedLabel(reviewLabel(node));
    if (!label) continue;
    used.add(label);
    const match = /^review-(\d+)$/i.exec(label);
    if (match) usedNumbers.add(Number(match[1]));
  }
  let number = 1;
  while (usedNumbers.has(number) || used.has(`review-${number}`)) number += 1;
  return `review-${number}`;
}

function dispatch(view: EditorView, transaction: { scrollIntoView?: () => unknown }): void {
  // The transaction's selection is already mapped through all preceding
  // steps. Keeping it avoids leaking a DOM-specific selection implementation
  // into this UI-independent module.
  view.dispatch(transaction as Parameters<EditorView["dispatch"]>[0]);
}

function normalizeNote(note: string): string {
  return note
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Insert one reference at the end of the selected passage and one definition
 * at the document end.  The two inserts intentionally share one transaction.
 */
export function createReviewNote(view: EditorView, note: unknown, selection?: Selection): CommandResult {
  if (typeof note !== "string") return fail("A review note must be text.");
  const normalized = normalizeNote(note);
  if (!normalized) return fail("A review note cannot be empty.");

  const chosen = selection ?? view.state.selection;
  if (chosen.$from.doc !== view.state.doc || chosen.$to.doc !== view.state.doc) {
    return fail("The selection is stale; choose the passage again.");
  }
  if (chosen.empty) return fail("Select a passage before adding a review note.");
  if (!chosen.$from.parent.isTextblock || !chosen.$to.parent.isTextblock) {
    return fail("A review note must be attached to text in a text block.");
  }
  if (chosen.$from.parent.type.name === "code_block" || chosen.$to.parent.type.name === "code_block") {
    return fail("A review note cannot be attached inside a code block.");
  }
  if (ancestorHas(chosen.$from, "footnote_definition") || ancestorHas(chosen.$to, "footnote_definition")) {
    return fail("A review note cannot be created inside a review definition.");
  }
  if (selectionContainsNodeType(chosen, "footnote_definition")) {
    return fail("A review note cannot include an existing review definition.");
  }
  if (chosen.from < 0 || chosen.to > view.state.doc.content.size || chosen.from > chosen.to) {
    return fail("The selection is outside the current document.");
  }

  const referenceType = view.state.schema.nodes.footnote_reference;
  const definitionType = view.state.schema.nodes.footnote_definition;
  const paragraphType = view.state.schema.nodes.paragraph;
  if (!referenceType || !definitionType || !paragraphType) {
    return fail("This editor schema does not support review notes.");
  }

  const label = allocateReviewLabel(view.state.doc);
  let reference: ProseMirrorNode;
  let definition: ProseMirrorNode;
  try {
    reference = referenceType.create({ label });
    const paragraph = paragraphType.create(null, view.state.schema.text(normalized));
    definition = definitionType.create({ label }, paragraph);
  } catch {
    return fail("This editor schema cannot represent a review note.");
  }

  const originalEnd = view.state.doc.content.size;
  let transaction;
  try {
    transaction = view.state.tr.insert(chosen.to, reference);
    transaction.insert(transaction.mapping.map(originalEnd, 1), definition);
  } catch {
    return fail("A review reference cannot be inserted at the end of this selection.");
  }
  dispatch(view, transaction.scrollIntoView());
  return ok();
}

/** Lift selected quote children one level, preserving nested lists and other blocks. */
export const decreaseQuoteLevel: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, node => node.type.name === "blockquote");
  if (!range) return false;
  const target = liftTarget(range);
  if (target === null || target !== range.depth - 1) return false;
  dispatch?.(state.tr.lift(range, target).scrollIntoView());
  return true;
};
