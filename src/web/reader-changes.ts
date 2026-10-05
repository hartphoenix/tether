import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { captureAnchor, resolveAnchor } from './annotations-ui';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { computeDocDiff } from '@milkdown/kit/plugin/diff';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { normalizeFootnotes } from './footnotes';

/** Apply the same structural diff as desktop review, without rebuilding the editor. */
export function updateReaderBody(editor: Editor, markdown: string): Array<{ before: string; after: string }> {
  return editor.action(ctx => {
    const view = ctx.get(editorViewCtx), parsed = ctx.get(parserCtx)(markdown);
    if (!parsed) throw new Error('Could not read the updated document.');
    let state = EditorState.create({ doc: parsed });
    const footnotes = normalizeFootnotes(state);
    if (footnotes) state = state.apply(footnotes);
    const trailing = ctx.get(trailingConfig.key);
    if (trailing.shouldAppend(state.doc.lastChild, state)) state = state.apply(state.tr.insert(state.doc.content.size, trailing.getNode(state)));
    const before = view.state.doc, after = state.doc;
    const changes = computeDocDiff(before, after);
    const summaries = changes.map(change => ({
      before: before.textBetween(change.fromA, change.toA, '\n'),
      after: after.textBetween(change.fromB, change.toB, '\n'),
    }));
    const lane = view.dom.closest<HTMLElement>('.wm-document-scroll');
    const scroll = lane?.scrollTop ?? 0;
    const box = lane?.getBoundingClientRect();
    const visible = box && view.posAtCoords({ left: box.left + box.width / 2, top: box.top + 40 });
    const top = visible ? view.coordsAtPos(visible.pos).top : null;
    let tr = view.state.tr;
    for (const change of [...changes].reverse()) tr = tr.replace(change.fromA, change.toA, after.slice(change.fromB, change.toB));
    // Attribute-only changes can be omitted by the text diff; do not display a stale tree.
    if (!tr.doc.eq(after)) {
      const anchor = captureAnchor(view);
      tr = view.state.tr.replaceWith(0, before.content.size, after.content);
      const selection = anchor && resolveAnchor(after, anchor);
      if (selection) tr.setSelection(TextSelection.create(tr.doc, selection.ranges[0]!.from, selection.ranges.at(-1)!.to));
    }
    const mapped = visible ? tr.mapping.map(visible.pos) : null;
    view.dispatch(tr.setMeta('addToHistory', false));
    if (lane) lane.scrollTop = scroll + (mapped !== null && top !== null ? view.coordsAtPos(Math.min(mapped, view.state.doc.content.size)).top - top : 0);
    return summaries;
  });
}

export function createChangesInspector() {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'wm-reader-changes'; button.textContent = 'View changes'; button.hidden = true;
  let latest: { before: string; after: string; changes: Array<{ before: string; after: string }> } | undefined;
  button.onclick = () => {
    if (!latest) return;
    const dialog = document.createElement('dialog'); dialog.className = 'wm-changes-dialog';
    dialog.setAttribute('aria-label', 'Document changes');
    const title = document.createElement('h2'); title.textContent = 'Latest document changes';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close();
    dialog.append(title, close);
    const versions = (parent: HTMLElement, before: string, after: string) => {
      for (const [label, text] of [['Before', before], ['Now', after]]) {
        const heading = document.createElement('h3'); heading.textContent = label;
        const pre = document.createElement('pre'); pre.textContent = text || '(empty)';
        parent.append(heading, pre);
      }
    };
    for (const change of latest.changes) {
      const section = document.createElement('section'); versions(section, change.before, change.after); dialog.append(section);
    }
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Full Markdown comparison';
    details.append(summary); versions(details, latest.before, latest.after); dialog.append(details);
    dialog.addEventListener('close', () => { dialog.remove(); button.focus({ preventScroll: true }); });
    document.body.append(dialog); dialog.showModal();
  };
  document.body.append(button);
  return { record(before: string, after: string, changes: Array<{ before: string; after: string }>) { latest = { before, after, changes }; button.hidden = false; } };
}
