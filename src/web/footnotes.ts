import type { Ctx } from "@milkdown/kit/ctx";
import { footnoteDefinitionSchema, footnoteReferenceSchema } from "@milkdown/kit/preset/gfm";
import { Plugin, TextSelection, type Selection, type EditorState } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { CommandResult } from "./editor-commands";

export const footnoteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18 9 6l5 12M6 14h6M17 4h2v7m-2 0h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Numbers are editor state only; Markdown serializes the stable label. */
export function configureFootnotes(ctx: Ctx): void {
  ctx.update(footnoteReferenceSchema.key, previous => context => ({
    ...previous(context),
    attrs: { ...previous(context).attrs, number: { default: null } },
    parseDOM: previous(context).parseDOM?.map(rule => ({ ...rule, getAttrs: (dom: HTMLElement) => {
      const attrs = rule.getAttrs?.(dom);
      if (attrs === false) return false;
      return { ...attrs, number: dom.dataset.number ? Number(dom.dataset.number) : null };
    } })),
    toDOM: node => ["sup", { "data-type": "footnote_reference", "data-label": node.attrs.label, "data-number": node.attrs.number }, String(node.attrs.number ?? "?")],
  }));
  ctx.update(footnoteDefinitionSchema.key, previous => context => ({
    ...previous(context),
    attrs: { ...previous(context).attrs, number: { default: null } },
    parseDOM: previous(context).parseDOM?.map(rule => ({ ...rule, getAttrs: (dom: HTMLElement) => {
      const attrs = rule.getAttrs?.(dom);
      if (attrs === false) return false;
      return { ...attrs, number: dom.dataset.number ? Number(dom.dataset.number) : null };
    } })),
    toDOM: node => ["dl", { "data-type": "footnote_definition", "data-label": node.attrs.label, "data-number": node.attrs.number }, ["dt", { contenteditable: "false", role: "link", tabindex: "0", "aria-label": `Return to footnote ${node.attrs.number ?? "reference"}` }, String(node.attrs.number ?? "?")], ["dd", 0]],
  }));
}

export function insertFootnote(view: EditorView, text: string, selection: Selection = view.state.selection): CommandResult {
  const fail = (reason: string): CommandResult => ({ ok: false, reason });

  if (!text.trim()) return fail("Enter footnote text.");
  if (selection.$from.doc !== view.state.doc || selection.$to.doc !== view.state.doc) return fail("The document changed. Select the passage again.");
  if (!view.editable) return fail("This document is read-only.");
  if (!selection.$to.parent.isTextblock || selection.$to.parent.type.spec.code) return fail("End the selection in ordinary text, outside a code block.");
  for (let depth = selection.$to.depth; depth > 0; depth--) {
    if (selection.$to.node(depth).type.name === "footnote_definition") return fail("Footnotes cannot be inserted inside another footnote.");
  }
  const used = new Set<string>();
  view.state.doc.descendants(node => {
    if (node.type.name.startsWith("footnote_")) used.add(String(node.attrs.label).toLowerCase());
  });
  let label: string;
  do { label = `note-${crypto.randomUUID().slice(0, 8)}`; } while (used.has(label));
  const { footnote_reference: reference, footnote_definition: definition, paragraph } = view.state.schema.nodes;
  if (!reference || !definition || !paragraph) return fail("This editor does not support footnotes.");
  const paragraphs = text.trim().split(/\n\s*\n/).map(value => paragraph.create(null, view.state.schema.text(value)));
  const transaction = view.state.tr.insert(selection.to, reference.create({ label }));
  transaction.insert(transaction.doc.content.size, definition.create({ label }, paragraphs));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return { ok: true };
}

const key = (label: string) => label.toUpperCase();

/** Keep definitions at the end, preserving labels and editor selection during moves. */
export function normalizeFootnotes(state: EditorState) {
  const numbers = new Map<string, number>();
  state.doc.descendants(node => {
    if (node.type.name === "footnote_definition") return false;
    if (node.type.name === "footnote_reference" && !numbers.has(key(node.attrs.label))) numbers.set(key(node.attrs.label), numbers.size + 1);
  });
  const definitions: { node: Node; pos: number }[] = [];
  state.doc.forEach((node, pos) => { if (node.type.name === "footnote_definition") definitions.push({ node, pos }); });
  const ordered = [...definitions].sort((a, b) => (numbers.get(key(a.node.attrs.label)) ?? Infinity) - (numbers.get(key(b.node.attrs.label)) ?? Infinity));
  const tr = state.tr;
  // Crepe requires a final empty paragraph as an editable caret target. It is not a footnote or saved content.
  const last = state.doc.lastChild;
  const trailingSize = last?.type.name === "paragraph" && last.content.size === 0 ? last.nodeSize : 0;
  const tailStart = state.doc.content.size - trailingSize - definitions.reduce((sum, item) => sum + item.node.nodeSize, 0);
  const needsMove = definitions.some((item, i) => item !== ordered[i]) || definitions[0]?.pos !== tailStart;
  if (definitions.length && needsMove) {
    const selected = definitions.find(({node,pos}) => state.selection.from > pos && state.selection.to < pos + node.nodeSize);
    for (const item of [...definitions].reverse()) tr.delete(item.pos, item.pos + item.node.nodeSize);
    let offset = tr.doc.content.size - trailingSize;
    for (const item of ordered) {
      tr.insert(offset, item.node);
      if (item === selected) tr.setSelection(TextSelection.create(tr.doc, offset + state.selection.from - item.pos, offset + state.selection.to - item.pos));
      offset += item.node.nodeSize;
    }
  }
  tr.doc.descendants((node, pos) => {
    if (node.type.name !== "footnote_reference" && node.type.name !== "footnote_definition") return;
    const number = numbers.get(key(node.attrs.label)) ?? null;
    if (!("number" in (node.type.spec.attrs ?? {}))) throw new Error("Footnote number attribute missing from schema");
    if (node.attrs.number !== number) tr.setNodeMarkup(pos, undefined, { ...node.attrs, number });
  });
  return tr.docChanged ? tr : null;
}

export const createFootnoteOrderingPlugin = () => new Plugin({
  appendTransaction: (transactions, _old, state) => transactions.some(tr => tr.docChanged || tr.getMeta("normalizeFootnotes")) ? normalizeFootnotes(state) : null,
  view: view => {
    let alive = true;
    queueMicrotask(() => { if (alive) view.dispatch(view.state.tr.setMeta("normalizeFootnotes", true).setMeta("addToHistory", false)); });
    return { destroy: () => { alive = false; } };
  },
});
export const footnoteOrdering = $prose(createFootnoteOrderingPlugin);
