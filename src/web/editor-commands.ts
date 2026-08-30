import type { EditorView } from "@milkdown/kit/prose/view";
import type { Mark, MarkType, Node as ProseMirrorNode, NodeType } from "@milkdown/kit/prose/model";
import type { Selection } from "@milkdown/kit/prose/state";

/** The two useful states for an affordance in a formatting surface. */
export type TagState = "on" | "mixed" | "off";

export type TagKind = "mark" | "block" | "review" | "context";

export type TagRange = {
  from: number;
  to: number;
};

export type TagValue = string | number | {
  href?: string;
  url?: string;
  title?: string | null;
  note?: string;
  text?: string;
  [key: string]: unknown;
};

/**
 * A descriptor is deliberately a snapshot, rather than an instruction such
 * as "toggle bold".  `identity` is used to prove that a later mutation still
 * addresses the document from which this descriptor was read.
 */
export type TagDescriptor = {
  /** Stable, position-independent identifier (for example `mark:strong`). */
  id: string;
  label: string;
  kind: TagKind;
  state: TagState;
  removable: boolean;
  editable: boolean;
  range: TagRange;
  /** Alias useful to callers that want to make the snapshot explicit. */
  capturedRange: TagRange;
  value?: TagValue;
  reason?: string;
  /** Reference identity and the range snapshot used for stale detection. */
  identity: TagIdentity;
  /** Present for review-reference rows. */
  reference?: ReviewReferenceIdentity;
};

export type CommandResult =
  | { ok: true }
  | { ok: false; reason: string };

export type TagIdentity = {
  kind: TagKind;
  type: string;
  from: number;
  to: number;
  fingerprint: string;
  markAttrs?: Record<string, unknown>;
  label?: string;
  definitionFrom?: number;
  definitionFingerprint?: string;
  homogeneous?: boolean;
  stored?: boolean;
};

export type ReviewReferenceIdentity = {
  label: string;
  from: number;
  to: number;
  fingerprint: string;
  definitionFrom?: number;
  definitionFingerprint?: string;
};

type TextSample = {
  node: ProseMirrorNode;
  from: number;
  to: number;
};

const MARKS: readonly {
  key: string;
  names: readonly string[];
  label: string;
}[] = [
  { key: "strong", names: ["strong"], label: "Bold" },
  { key: "emphasis", names: ["emphasis", "em"], label: "Italic" },
  { key: "strike", names: ["strike_through", "strike", "strikethrough"], label: "Strikethrough" },
  { key: "inline-code", names: ["inlineCode", "inline_code", "code"], label: "Inline code" },
  { key: "link", names: ["link"], label: "Link" },
];

const LIST_NAMES = new Set([
  "bullet_list",
  "ordered_list",
  "list_item",
  "task_list_item",
  "task_list",
]);
const TABLE_NAMES = new Set([
  "table",
  "table_row",
  "table_cell",
  "table_header",
  "table_header_row",
]);

const ok = (): CommandResult => ({ ok: true });
const fail = (reason: string): CommandResult => ({ ok: false, reason });

function markTypeFor(view: EditorView, names: readonly string[]): MarkType | undefined {
  for (const name of names) {
    const type = view.state.schema.marks[name];
    if (type) return type;
  }
  return undefined;
}

function markFrom(node: ProseMirrorNode, type: MarkType): Mark | undefined {
  return node.marks.find((mark) => mark.type === type);
}

function markData(mark: Mark | undefined): unknown {
  if (!mark) return null;
  return { type: mark.type.name, attrs: mark.attrs };
}

function nodeFingerprint(node: ProseMirrorNode | null | undefined): string {
  if (!node) return "<missing>";
  return JSON.stringify(node.toJSON());
}

/** Include text, inline atoms, and every mark in a range. */
function rangeFingerprint(doc: ProseMirrorNode, from: number, to: number): string {
  const pieces: unknown[] = [];
  if (from > to || from < 0 || to > doc.content.size) return "<invalid-range>";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const nodeFrom = Math.max(from, pos);
      const nodeTo = Math.min(to, pos + node.nodeSize);
      if (nodeFrom < nodeTo) {
        pieces.push({
          pos,
          from: nodeFrom,
          to: nodeTo,
          text: node.text?.slice(nodeFrom - pos, nodeTo - pos),
          marks: node.marks.map(markData),
        });
      }
      return false;
    }
    if (node.isInline && pos >= from && pos < to) {
      pieces.push({ pos, node: nodeFingerprint(node) });
    }
    return true;
  });
  return JSON.stringify(pieces);
}

function selectedTextSamples(doc: ProseMirrorNode, from: number, to: number): TextSample[] {
  const samples: TextSample[] = [];
  if (from >= to) return samples;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start < end) samples.push({ node, from: start, to: end });
    return false;
  });
  return samples;
}

function marksEqual(a: Mark | undefined, b: Mark | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.eq(b);
}

/**
 * Find the maximal run carrying `type` around a cursor.  This is done in the
 * cursor's textblock so a mark can never accidentally cross a block boundary.
 */
function collapsedMarkRange(
  selection: Selection,
  type: MarkType,
): { range: TagRange; mark: Mark } | undefined {
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (!parent.isTextblock) return undefined;
  const depth = $pos.depth;
  const start = $pos.start(depth);
  const cursor = $pos.parentOffset;
  const children: { node: ProseMirrorNode; from: number; to: number }[] = [];
  parent.forEach((node, offset) => {
    children.push({ node, from: offset, to: offset + node.nodeSize });
  });

  let index = children.findIndex(({ from, to }) => from < cursor && cursor < to);
  if (index < 0) {
    // At a boundary, ProseMirror's marks() reflects the side that would be
    // used for typed text. Prefer that side, then the adjacent text nodes.
    const active = $pos.marks().find((mark) => mark.type === type);
    if (!active) return undefined;
    index = children.findIndex(({ from, to }) => from === cursor || to === cursor);
    if (index < 0) return undefined;
    const candidate = children[index];
    if (!candidate.node.isText || !marksEqual(markFrom(candidate.node, type), active)) {
      const next = children[index + 1];
      const previous = children[index - 1];
      if (next?.node.isText && marksEqual(markFrom(next.node, type), active)) index += 1;
      else if (previous?.node.isText && marksEqual(markFrom(previous.node, type), active)) index -= 1;
    }
  }

  const candidate = children[index];
  if (!candidate?.node.isText) return undefined;
  const mark = markFrom(candidate.node, type);
  if (!mark) return undefined;

  let left = index;
  let right = index;
  while (
    left > 0 &&
    children[left - 1]?.node.isText &&
    marksEqual(markFrom(children[left - 1].node, type), mark)
  ) left -= 1;
  while (
    right + 1 < children.length &&
    children[right + 1]?.node.isText &&
    marksEqual(markFrom(children[right + 1].node, type), mark)
  ) right += 1;

  return {
    range: {
      from: start + children[left].from,
      to: start + children[right].to,
    },
    mark,
  };
}

function nearestTextblock($pos: Selection["$from"]): { node: ProseMirrorNode; from: number; depth: number } | undefined {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!node.isTextblock) continue;
    return { node, from: $pos.before(depth), depth };
  }
  return undefined;
}

function contextNodes(selection: Selection): { node: ProseMirrorNode; from: number }[] {
  const result = new Map<string, { node: ProseMirrorNode; from: number }>();
  const add = ($pos: Selection["$from"]): void => {
    for (let depth = 1; depth <= $pos.depth; depth += 1) {
      const node = $pos.node(depth);
      const name = node.type.name;
      if (!LIST_NAMES.has(name) && name !== "blockquote" && !TABLE_NAMES.has(name)) continue;
      const from = $pos.before(depth);
      result.set(`${name}:${from}`, { node, from });
    }
  };
  add(selection.$from);
  add(selection.$to);
  return [...result.values()];
}

function displayContextName(node: ProseMirrorNode): string {
  const name = node.type.name.replace(/_/g, " ");
  return name.replace(/(^| )\w/g, (letter) => letter.toUpperCase());
}

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

function findDefinition(
  doc: ProseMirrorNode,
  label: string,
): { node: ProseMirrorNode; from: number } | undefined {
  const wanted = normalizedLabel(label);
  const { definitions } = definitionsAndReferences(doc);
  return definitions.find(({ node }) => normalizedLabel(reviewLabel(node)) === wanted);
}

function referenceAt(doc: ProseMirrorNode, from: number, to: number): ProseMirrorNode | undefined {
  const node = doc.nodeAt(from);
  if (!node || node.type.name !== "footnote_reference" || from + node.nodeSize !== to) return undefined;
  return node;
}

function referenceDescriptor(
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  from: number,
): TagDescriptor {
  const to = from + node.nodeSize;
  const label = reviewLabel(node);
  const definition = findDefinition(doc, label);
  const reference: ReviewReferenceIdentity = {
    label,
    from,
    to,
    fingerprint: nodeFingerprint(node),
    ...(definition
      ? { definitionFrom: definition.from, definitionFingerprint: nodeFingerprint(definition.node) }
      : {}),
  };
  const identity: TagIdentity = {
    kind: "review",
    type: "footnote_reference",
    from,
    to,
    fingerprint: reference.fingerprint,
    label,
    ...(definition
      ? { definitionFrom: definition.from, definitionFingerprint: nodeFingerprint(definition.node) }
      : {}),
  };
  return {
    id: `review:${normalizedLabel(label)}`,
    label: `Review note · ${label}`,
    kind: "review",
    state: "on",
    removable: true,
    editable: Boolean(definition),
    range: { from, to },
    capturedRange: { from, to },
    value: definition?.node.textContent,
    reason: definition ? undefined : "This review reference has no definition.",
    identity,
    reference,
  };
}

function referencePositions(selection: Selection): { node: ProseMirrorNode; from: number }[] {
  const result = new Map<number, ProseMirrorNode>();
  const addAt = (from: number): void => {
    const node = selection.$from.doc.nodeAt(from);
    if (node?.type.name === "footnote_reference") result.set(from, node);
  };
  if (selection.from < selection.to) {
    selection.$from.doc.nodesBetween(selection.from, selection.to, (node, from) => {
      if (node.type.name === "footnote_reference" && from >= selection.from && from < selection.to) {
        result.set(from, node);
      }
      return true;
    });
    // `nodesBetween` intentionally skips an atom when the range starts at
    // its end in a few Selection implementations. Explicitly inspect both
    // ends so a NodeSelection of a reference is never lost.
    addAt(selection.from);
    addAt(selection.to - 1);
  } else {
    const before = selection.$from.nodeBefore;
    const beforeFrom = selection.from - (before?.nodeSize ?? 0);
    if (before?.type.name === "footnote_reference") result.set(beforeFrom, before);
    const after = selection.$from.nodeAfter;
    if (after?.type.name === "footnote_reference") result.set(selection.from, after);
    addAt(selection.from);
    addAt(selection.from - 1);
  }
  return [...result.entries()].map(([from, node]) => ({ from, node }));
}

function markDescriptor(
  doc: ProseMirrorNode,
  key: string,
  markType: MarkType,
  label: string,
  state: TagState,
  range: TagRange,
  mark: Mark | undefined,
  homogeneous: boolean,
  stored = false,
): TagDescriptor {
  const attrs = mark?.attrs;
  const identity: TagIdentity = {
    kind: "mark",
    type: markType.name,
    from: range.from,
    to: range.to,
    fingerprint: rangeFingerprint(doc, range.from, range.to),
    ...(attrs ? { markAttrs: attrs } : {}),
    homogeneous,
    stored,
  };
  const value = key === "link"
    ? { href: typeof attrs?.href === "string" ? attrs.href : "", title: attrs?.title ?? null }
    : undefined;
  return {
    id: `mark:${key}`,
    label,
    kind: "mark",
    state,
    removable: state !== "off",
    editable: key === "link",
    range,
    capturedRange: range,
    value,
    reason: key === "link" && state === "off"
      ? "Enter a URL to apply this link."
      : key === "link" && !homogeneous
        ? "Link editing requires one homogeneous link."
      : key !== "link"
        ? state === "off" ? "Toggle this tag to apply it." : "Binary marks do not have editable values."
        : undefined,
    identity,
  };
}

function blockDescriptor(
  node: ProseMirrorNode,
  from: number,
): TagDescriptor {
  const isHeading = node.type.name === "heading";
  const level = typeof node.attrs.level === "number" ? node.attrs.level : undefined;
  const range = { from, to: from + node.nodeSize };
  const identity: TagIdentity = {
    kind: "block",
    type: node.type.name,
    from,
    to: range.to,
    fingerprint: nodeFingerprint(node),
  };
  return {
    id: `block:${isHeading ? "heading" : "paragraph"}`,
    label: isHeading ? `Heading ${level ?? 1}` : "Paragraph",
    kind: "block",
    state: "on",
    removable: isHeading,
    editable: true,
    range,
    capturedRange: range,
    value: isHeading ? level ?? 1 : "paragraph",
    reason: isHeading ? undefined : "Paragraph is already the base block style.",
    identity,
  };
}

function contextDescriptor(node: ProseMirrorNode, from: number): TagDescriptor {
  const range = { from, to: from + node.nodeSize };
  const identity: TagIdentity = {
    kind: "context",
    type: node.type.name,
    from,
    to: range.to,
    fingerprint: nodeFingerprint(node),
  };
  return {
    id: `context:${node.type.name}`,
    label: displayContextName(node),
    kind: "context",
    state: "on",
    removable: false,
    editable: false,
    range,
    capturedRange: range,
    reason: "Structural context is read-only.",
    identity,
  };
}

/** Return the formatting/context rows relevant to the current selection. */
export function getSelectionTags(view: EditorView): TagDescriptor[] {
  const { state } = view;
  const { selection, doc } = state;
  const tags: TagDescriptor[] = [];
  const samples = selectedTextSamples(doc, selection.from, selection.to);
  const textLength = samples.reduce((sum, sample) => sum + sample.to - sample.from, 0);

  for (const descriptor of MARKS) {
    const markType = markTypeFor(view, descriptor.names);
    if (!markType) continue;

    let range: TagRange | undefined;
    let mark: Mark | undefined;
    let markState: TagState | undefined;
    let homogeneous = false;
    let stored = false;

    if (selection.empty) {
      const collapsed = collapsedMarkRange(selection, markType);
      if (collapsed) {
        range = collapsed.range;
        mark = collapsed.mark;
        markState = "on";
        homogeneous = true;
      } else {
        const storedMark = state.storedMarks?.find((candidate) => candidate.type === markType);
        if (storedMark) {
          range = { from: selection.from, to: selection.to };
          mark = storedMark;
          markState = "on";
          homogeneous = true;
          stored = true;
        }
      }
    } else if (textLength > 0) {
      const carrying = samples.filter((sample) => Boolean(markFrom(sample.node, markType)));
      if (carrying.length > 0) {
        const carryingLength = carrying.reduce((sum, sample) => sum + sample.to - sample.from, 0);
        markState = carryingLength === textLength ? "on" : "mixed";
        mark = markFrom(carrying[0].node, markType);
        homogeneous = markState === "on" && carrying.every((sample) => {
          return marksEqual(markFrom(sample.node, markType), mark);
        });
        range = { from: selection.from, to: selection.to };

        // A homogeneous link is represented by the complete link run, even
        // when the user selected only part of its text.
        if (descriptor.key === "link" && homogeneous) {
          const first = carrying[0];
          // The generic selected range is safer for a multi-block selection;
          // only expand when all selected text belongs to one textblock.
          const $from = selection.$from;
          const $to = selection.$to;
          if ($from.parent === $to.parent && $from.parent.isTextblock) {
            const collapsedLike = expandMarkWithinParent($from, markType, mark, selection.from, selection.to);
            if (collapsedLike) range = collapsedLike;
          } else {
            range = { from: first.from, to: carrying[carrying.length - 1].to };
          }
        }
      }
    }

    const descriptorRange = range ?? { from: selection.from, to: selection.to };
    tags.push(markDescriptor(
      doc,
      descriptor.key,
      markType,
      descriptor.label,
      markState ?? "off",
      descriptorRange,
      mark,
      homogeneous,
      stored,
    ));
  }

  const block = nearestTextblock(selection.$from);
  if (block && (block.node.type.name === "paragraph" || block.node.type.name === "heading")) {
    tags.push(blockDescriptor(block.node, block.from));
  }

  for (const context of contextNodes(selection)) tags.push(contextDescriptor(context.node, context.from));

  for (const { node, from } of referencePositions(selection)) {
    // Preserve editing for the old experimental review-* notes without
    // misclassifying ordinary Markdown footnotes as annotation threads.
    if (/^review-/i.test(reviewLabel(node))) tags.push(referenceDescriptor(doc, node, from));
  }

  return tags;
}

function expandMarkWithinParent(
  $pos: Selection["$from"],
  type: MarkType,
  target: Mark | undefined,
  selectedFrom = 0,
  selectedTo = Number.MAX_SAFE_INTEGER,
): TagRange | undefined {
  if (!$pos.parent.isTextblock || !target) return undefined;
  const start = $pos.start($pos.depth);
  const children: { node: ProseMirrorNode; from: number; to: number }[] = [];
  $pos.parent.forEach((node, offset) => children.push({ node, from: offset, to: offset + node.nodeSize }));
  let first = -1;
  let last = -1;
  const parentStart = $pos.start($pos.depth);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const absoluteFrom = parentStart + child.from;
    const absoluteTo = parentStart + child.to;
    if (absoluteTo <= selectedFrom || absoluteFrom >= selectedTo) continue;
    if (!child.node.isText || !marksEqual(markFrom(child.node, type), target)) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0 || last < 0) return undefined;
  while (first > 0 && children[first - 1].node.isText && marksEqual(markFrom(children[first - 1].node, type), target)) first -= 1;
  while (last + 1 < children.length && children[last + 1].node.isText && marksEqual(markFrom(children[last + 1].node, type), target)) last += 1;
  return { from: start + children[first].from, to: start + children[last].to };
}

function staleDescriptor(descriptor: TagDescriptor): string | undefined {
  if (!descriptor.identity || descriptor.identity.kind !== descriptor.kind) return "This tag descriptor is invalid or stale.";
  if (descriptor.range.from !== descriptor.identity.from || descriptor.range.to !== descriptor.identity.to) {
    return "This tag descriptor is invalid or stale.";
  }
  return undefined;
}

function currentMarkMatches(
  view: EditorView,
  descriptor: TagDescriptor,
): { type: MarkType; mark: Mark | undefined } | CommandResult {
  const stale = staleDescriptor(descriptor);
  if (stale) return fail(stale);
  const type = view.state.schema.marks[descriptor.identity.type];
  if (!type) return fail("The mark is not present in this editor schema.");
  const current = rangeFingerprint(view.state.doc, descriptor.range.from, descriptor.range.to);
  if (current !== descriptor.identity.fingerprint) return fail("The tag is stale; the document changed since it was read.");
  let first: Mark | undefined;
  view.state.doc.nodesBetween(descriptor.range.from, descriptor.range.to, (node) => {
    const mark = markFrom(node, type);
    if (mark && !first) first = mark;
    return true;
  });
  if (!first) return fail("The mark is no longer present.");
  return { type, mark: first };
}

function currentBlockMatches(
  view: EditorView,
  descriptor: TagDescriptor,
): { node: ProseMirrorNode; type: NodeType } | CommandResult {
  const stale = staleDescriptor(descriptor);
  if (stale) return fail(stale);
  const node = view.state.doc.nodeAt(descriptor.range.from);
  if (!node || node.type.name !== descriptor.identity.type || nodeFingerprint(node) !== descriptor.identity.fingerprint) {
    return fail("The block is stale; the document changed since it was read.");
  }
  const type = view.state.schema.nodes[node.type.name];
  if (!type) return fail("The block is not present in this editor schema.");
  return { node, type };
}

function currentReferenceMatches(
  view: EditorView,
  descriptor: TagDescriptor,
): { node: ProseMirrorNode; label: string } | CommandResult {
  const stale = staleDescriptor(descriptor);
  if (stale) return fail(stale);
  const node = referenceAt(view.state.doc, descriptor.range.from, descriptor.range.to);
  if (!node || nodeFingerprint(node) !== descriptor.identity.fingerprint || descriptor.identity.type !== "footnote_reference") {
    return fail("The review reference is stale; the document changed since it was read.");
  }
  const label = reviewLabel(node);
  if (normalizedLabel(label) !== normalizedLabel(descriptor.identity.label ?? "")) {
    return fail("The review reference label changed since it was read.");
  }
  return { node, label };
}

function dispatch(view: EditorView, transaction: { scrollIntoView?: () => unknown }): void {
  // The transaction's selection is already mapped through all preceding
  // steps. Keeping it avoids leaking a DOM-specific selection implementation
  // into this UI-independent module.
  view.dispatch(transaction as Parameters<EditorView["dispatch"]>[0]);
}

/** Apply an available binary mark, or remove any active/mixed tag. */
export function setTagEnabled(
  view: EditorView,
  descriptor: TagDescriptor,
  enabled: boolean,
): CommandResult {
  if (!enabled) return removeTag(view, descriptor);
  if (descriptor.state !== "off") return ok();
  if (descriptor.kind !== "mark") return fail("This tag cannot be applied with a toggle.");
  if (descriptor.id === "mark:link") return fail("Open Link and enter a URL before applying it.");
  const stale = staleDescriptor(descriptor);
  if (stale) return fail(stale);
  if (rangeFingerprint(view.state.doc, descriptor.range.from, descriptor.range.to) !== descriptor.identity.fingerprint) {
    return fail("The tag is stale; the document changed since it was read.");
  }
  const type = view.state.schema.marks[descriptor.identity.type];
  if (!type) return fail("The mark is not present in this editor schema.");
  let transaction = view.state.tr;
  if (descriptor.range.from === descriptor.range.to) {
    transaction = transaction.addStoredMark(type.create());
  } else {
    const samples = selectedTextSamples(view.state.doc, descriptor.range.from, descriptor.range.to);
    if (!samples.length) return fail("Select text before applying this tag.");
    transaction = transaction.addMark(descriptor.range.from, descriptor.range.to, type.create());
  }
  dispatch(view, transaction.scrollIntoView());
  return ok();
}

/** Remove exactly the tag represented by a descriptor. */
export function removeTag(view: EditorView, descriptor: TagDescriptor): CommandResult {
  if (!descriptor.removable) return fail(descriptor.reason ?? "This tag is read-only.");

  if (descriptor.kind === "mark") {
    if (descriptor.identity.stored) {
      const stale = staleDescriptor(descriptor);
      if (stale) return fail(stale);
      if (rangeFingerprint(view.state.doc, descriptor.range.from, descriptor.range.to) !== descriptor.identity.fingerprint) {
        return fail("The tag is stale; the document changed since it was read.");
      }
      const type = view.state.schema.marks[descriptor.identity.type];
      if (!type || !view.state.storedMarks?.some((mark) => mark.type === type)) return fail("The stored mark is no longer active.");
      dispatch(view, view.state.tr.removeStoredMark(type));
      return ok();
    }
    const current = currentMarkMatches(view, descriptor);
    if ("ok" in current) return current;
    const transaction = view.state.tr.removeMark(descriptor.range.from, descriptor.range.to, current.type);
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  if (descriptor.kind === "block") {
    const current = currentBlockMatches(view, descriptor);
    if ("ok" in current) return current;
    if (current.node.type.name !== "heading") return fail("Only headings can be removed; paragraphs are the base style.");
    const paragraph = view.state.schema.nodes.paragraph;
    if (!paragraph) return fail("The paragraph block is not present in this editor schema.");
    const transaction = view.state.tr.setNodeMarkup(descriptor.range.from, paragraph, null, current.node.marks);
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  if (descriptor.kind === "review") {
    const current = currentReferenceMatches(view, descriptor);
    if ("ok" in current) return current;
    const expectedDefinitionFrom = descriptor.identity.definitionFrom;
    const expectedDefinitionFingerprint = descriptor.identity.definitionFingerprint;
    if (expectedDefinitionFrom !== undefined && expectedDefinitionFingerprint !== undefined) {
      const definition = view.state.doc.nodeAt(expectedDefinitionFrom);
      if (!definition || definition.type.name !== "footnote_definition" || nodeFingerprint(definition) !== expectedDefinitionFingerprint) {
        return fail("The review definition is stale; no content was changed.");
      }
    }

    const transaction = view.state.tr.delete(descriptor.range.from, descriptor.range.to);
    const remaining = definitionsAndReferences(transaction.doc).references.some(({ node }) => {
      return normalizedLabel(reviewLabel(node)) === normalizedLabel(current.label);
    });
    if (!remaining && expectedDefinitionFrom !== undefined && expectedDefinitionFingerprint !== undefined) {
      const mappedFrom = transaction.mapping.map(expectedDefinitionFrom, -1);
      const definition = transaction.doc.nodeAt(mappedFrom);
      if (!definition || definition.type.name !== "footnote_definition" || nodeFingerprint(definition) !== expectedDefinitionFingerprint) {
        return fail("The review definition is stale; no content was changed.");
      }
      transaction.delete(mappedFrom, mappedFrom + definition.nodeSize);
    }
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  return fail("This structural context is read-only.");
}

function linkValue(value: TagValue): { href: string; title?: string | null } | CommandResult {
  if (typeof value === "string") return { href: value };
  if (!value || typeof value !== "object") return fail("A link update needs a URL string or { href, title }.");
  if (Object.prototype.hasOwnProperty.call(value, "label")) return fail("Labels cannot be renamed.");
  const href = value.href ?? value.url;
  if (typeof href !== "string" || !href.trim()) return fail("A link URL must be a non-empty string.");
  if (value.title !== undefined && value.title !== null && typeof value.title !== "string") {
    return fail("A link title must be a string or null.");
  }
  return { href, title: value.title };
}

function blockTarget(value: TagValue): { name: "paragraph" | "heading"; level?: number } | undefined {
  if (typeof value === "number") return value >= 1 && value <= 6 ? { name: "heading", level: value } : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "paragraph" || normalized === "p") return { name: "paragraph" };
  const heading = /^(?:heading|h)[ -]?([1-6])$/.exec(normalized);
  if (heading) return { name: "heading", level: Number(heading[1]) };
  return undefined;
}

function noteValue(value: TagValue): string | CommandResult {
  if (typeof value === "string") {
    const note = normalizeNote(value);
    return note ? note : fail("A review note cannot be empty.");
  }
  if (!value || typeof value !== "object") return fail("A review update needs note text.");
  if (Object.prototype.hasOwnProperty.call(value, "label")) return fail("Labels cannot be renamed.");
  const candidate = value.note ?? value.text;
  if (typeof candidate !== "string") return fail("A review update needs note text.");
  const note = normalizeNote(candidate);
  return note ? note : fail("A review note cannot be empty.");
}

/** Update only values that are meaningful for the descriptor's tag kind. */
export function updateTag(view: EditorView, descriptor: TagDescriptor, value: TagValue): CommandResult {
  if (!descriptor.editable) return fail(descriptor.reason ?? "This tag is not editable.");

  if (descriptor.kind === "mark") {
    if (descriptor.id !== "mark:link") return fail("Binary marks do not support value updates.");
    if (descriptor.state !== "off" && (descriptor.state !== "on" || descriptor.identity.homogeneous !== true)) {
      return fail("Link updates require one homogeneous link.");
    }
    const next = linkValue(value);
    if ("ok" in next) return next;
    if (descriptor.state === "off") {
      const stale = staleDescriptor(descriptor);
      if (stale) return fail(stale);
      if (rangeFingerprint(view.state.doc, descriptor.range.from, descriptor.range.to) !== descriptor.identity.fingerprint) {
        return fail("The tag is stale; the document changed since it was read.");
      }
      const type = view.state.schema.marks[descriptor.identity.type];
      if (!type) return fail("The link mark is not present in this editor schema.");
      const attrs = { href: next.href, title: next.title ?? null };
      const transaction = descriptor.range.from === descriptor.range.to
        ? view.state.tr.addStoredMark(type.create(attrs))
        : view.state.tr.addMark(descriptor.range.from, descriptor.range.to, type.create(attrs));
      dispatch(view, transaction.scrollIntoView());
      return ok();
    }
    if (descriptor.identity.stored) {
      const stale = staleDescriptor(descriptor);
      if (stale) return fail(stale);
      const type = view.state.schema.marks[descriptor.identity.type];
      const current = view.state.storedMarks?.find((mark) => mark.type === type);
      if (!type || !current) return fail("The stored link is no longer active.");
      const attrs = { ...current.attrs, href: next.href, ...(next.title !== undefined ? { title: next.title } : {}) };
      dispatch(view, view.state.tr.removeStoredMark(type).addStoredMark(type.create(attrs)));
      return ok();
    }
    const current = currentMarkMatches(view, descriptor);
    if ("ok" in current) return current;
    const attrs: Record<string, unknown> = { ...current.mark?.attrs, href: next.href };
    if (next.title !== undefined) attrs.title = next.title;
    const replacement = current.type.create(attrs);
    const transaction = view.state.tr
      .removeMark(descriptor.range.from, descriptor.range.to, current.type)
      .addMark(descriptor.range.from, descriptor.range.to, replacement);
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  if (descriptor.kind === "block") {
    const current = currentBlockMatches(view, descriptor);
    if ("ok" in current) return current;
    const target = blockTarget(value);
    if (!target) return fail("Block style must be paragraph or heading 1–6.");
    const targetType = view.state.schema.nodes[target.name];
    if (!targetType) return fail(`The ${target.name} block is not present in this editor schema.`);
    const attrs = target.name === "heading"
      ? { level: target.level ?? 1, ...(Object.prototype.hasOwnProperty.call(targetType.spec.attrs ?? {}, "id") ? { id: current.node.attrs.id ?? "" } : {}) }
      : null;
    const transaction = view.state.tr.setNodeMarkup(descriptor.range.from, targetType, attrs, current.node.marks);
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  if (descriptor.kind === "review") {
    const current = currentReferenceMatches(view, descriptor);
    if ("ok" in current) return current;
    const note = noteValue(value);
    if (typeof note !== "string") return note;
    const definitionFrom = descriptor.identity.definitionFrom;
    const definitionFingerprint = descriptor.identity.definitionFingerprint;
    if (definitionFrom === undefined || definitionFingerprint === undefined) return fail("This review reference has no definition.");
    const definition = view.state.doc.nodeAt(definitionFrom);
    if (!definition || definition.type.name !== "footnote_definition" || nodeFingerprint(definition) !== definitionFingerprint) {
      return fail("The review definition is stale; no content was changed.");
    }
    const paragraph = view.state.schema.nodes.paragraph;
    if (!paragraph) return fail("The paragraph block is not present in this editor schema.");
    let replacement: ProseMirrorNode;
    try {
      replacement = paragraph.create(null, view.state.schema.text(note));
    } catch {
      return fail("The note cannot be represented as a paragraph in this schema.");
    }
    const transaction = view.state.tr.replaceWith(
      definitionFrom + 1,
      definitionFrom + definition.nodeSize - 1,
      replacement,
    );
    dispatch(view, transaction.scrollIntoView());
    return ok();
  }

  return fail("This structural context is read-only.");
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
