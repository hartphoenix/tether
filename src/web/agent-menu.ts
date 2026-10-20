/** Go-button actions, including keyboard context-menu access. */
export function openAgentMenu(options: {
  x: number; y: number; rename(): void; takeover(): Promise<void>; notice(message: string): void;
}): void {
  document.querySelector<HTMLElement>('.wm-agent-menu')?.dispatchEvent(new Event('dismiss'));
  const menu = document.createElement('div');
  menu.className = 'wm-file-menu wm-agent-menu';
  menu.setAttribute('role', 'menu');
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
  };
  const outside = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };
  for (const [label, action] of [
    ['Rename agent…', options.rename],
    ['Copy role takeover prompt', options.takeover],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.onclick = () => {
      close();
      try { void Promise.resolve(action()).catch(error => options.notice((error as Error).message)); }
      catch (error) { options.notice((error as Error).message); }
    };
    menu.append(button);
  }
  menu.addEventListener('dismiss', close);
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(options.x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(options.y, innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard, true);
  menu.querySelector('button')?.focus();
}
