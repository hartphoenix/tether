/**
 * Inline rename form for an agent, opened by right-clicking its name. A small
 * form instead of `prompt()`, which embedded webviews don't support.
 */
export function openAgentRename(options: { x: number; y: number; name: string; save: (name: string) => Promise<void> }): HTMLFormElement {
  document.querySelector('.wm-agent-rename')?.remove();
  const form = document.createElement('form');
  form.className = 'wm-agent-rename';
  form.setAttribute('aria-label', `Rename ${options.name}`);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = options.name;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Agent name');
  const error = document.createElement('p');
  error.className = 'wm-agent-rename-error';
  error.hidden = true;
  form.append(input, error);
  const close = () => { form.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (event: PointerEvent) => { if (!form.contains(event.target as Node)) close(); };
  form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || name === options.name) { close(); return; }
    input.disabled = true;
    options.save(name).then(close, (reason: unknown) => {
      input.disabled = false;
      error.textContent = reason instanceof Error ? reason.message : 'The agent could not be renamed.';
      error.hidden = false;
      input.focus();
    });
  });
  document.body.append(form);
  const width = form.offsetWidth, height = form.offsetHeight;
  form.style.left = `${Math.max(8, Math.min(options.x, innerWidth - width - 8))}px`;
  form.style.top = `${Math.max(8, Math.min(options.y, innerHeight - height - 8))}px`;
  document.addEventListener('pointerdown', outside, true);
  input.focus();
  input.select();
  return form;
}

/** Open the rename form from a right-click or the keyboard's context-menu key. */
export function bindAgentRename(element: HTMLElement, open: (x: number, y: number) => void): void {
  element.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); open(event.clientX, event.clientY); });
  element.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    open(rect.left, rect.bottom);
  });
}
