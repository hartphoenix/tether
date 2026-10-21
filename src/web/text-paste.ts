/** Insert the event's text before Chromium can invalidate its subsequent clipboard read. */
export function pasteTextInput(event: ClipboardEvent): void {
  const field = event.target as HTMLTextAreaElement | HTMLInputElement | null;
  if (!field || !('matches' in field) || !field.matches('textarea,input') ||
      (field.tagName === 'INPUT' && !['text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(field.type))) return;
  const doc = field.ownerDocument;
  if (event.defaultPrevented || field.readOnly || field.disabled || doc.activeElement !== field ||
      typeof doc.execCommand !== 'function') return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;

  // End the previous typing transaction where the control supports selection.
  // This gives consecutive dictations separate Undo steps.
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = field;
  const temporary = start === 0 ? field.value.length : 0;
  if (start !== null && end !== null) {
    field.setSelectionRange(temporary, temporary);
    field.setSelectionRange(start, end, direction ?? undefined);
  }
  // Unlike assigning value/setRangeText, insertText preserves native Undo/Redo.
  // Leave native paste available if the editing command is unsupported.
  if (doc.execCommand('insertText', false, text)) event.preventDefault();
}
