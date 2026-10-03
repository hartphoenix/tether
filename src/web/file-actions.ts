import { iconSvg } from './icons';

export function createFileActions(options: {
  copy(): Promise<void>; reveal(): Promise<void>; move(target?: string): Promise<void>; export(): Promise<void>;
  path(): string; notice(message: string): void;
}) {
  const root = document.createElement('span');
  root.className = 'wm-file-actions';
  root.innerHTML = `<button type="button" class="wm-comment-button" title="File actions" aria-label="File actions" aria-expanded="false">${iconSvg('file-code')}</button><span class="wm-file-menu" hidden></span>`;
  const trigger = root.querySelector('button')!;
  const menu = root.querySelector<HTMLElement>('.wm-file-menu')!;
  let dialog: HTMLDialogElement | undefined;
  let nativeMove = false;
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const run = async (action: () => Promise<void>) => { close(); try { await action(); } catch (error) { options.notice((error as Error).message); } };
  const add = (label: string, icon: Parameters<typeof iconSvg>[0], action: () => Promise<void>) => {
    const button = document.createElement('button'); button.type = 'button';
    button.innerHTML = iconSvg(icon);
    button.append(document.createTextNode(label));
    button.addEventListener('click', () => void run(action)); menu.append(button);
    return button;
  };
  add('Copy file path', 'file-code', options.copy);
  const reveal = add('Reveal in Finder', 'folder-open', options.reveal);
  const move = add('Move file…', 'folder-simple-dashed', async () => {
    if (nativeMove) { await options.move(); return; }
    dialog?.remove();
    dialog = document.createElement('dialog'); dialog.className = 'wm-move-dialog';
    const form = document.createElement('form');
    const label = document.createElement('label'); label.textContent = 'Move file to';
    const input = document.createElement('input'); input.value = options.path(); input.required = true; input.setAttribute('aria-label', 'Destination path');
    const error = document.createElement('p'); error.setAttribute('role', 'alert');
    const buttons = document.createElement('div');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog?.close();
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Move';
    buttons.append(cancel, submit); label.append(input); form.append(label, error, buttons); dialog.append(form);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true;
      try { await options.move(input.value); dialog?.close(); } catch (reason) { error.textContent = (reason as Error).message; }
      finally { submit.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal(); input.focus();
  });
  add('Export with annotations', 'file-arrow-down', options.export);
  trigger.onclick = () => { menu.hidden = !menu.hidden; trigger.setAttribute('aria-expanded', String(!menu.hidden)); };
  const outside = (event: Event) => { if (event.target instanceof Node && !root.contains(event.target)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
  return { root, update(revealAvailable: boolean, readOnly: boolean, pickerAvailable = nativeMove) { reveal.hidden = !revealAvailable; move.disabled = readOnly; nativeMove = pickerAvailable; }, destroy() { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); root.remove(); dialog?.remove(); } };
}
