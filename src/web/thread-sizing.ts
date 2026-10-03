import { iconSvg } from './icons';
import { placeOverlay } from './overlay';

type Sizing = { uiScale?: number; commentTextSize?: number };
export function createThreadSizing(change: (value: Sizing) => Promise<unknown>, notice: (message: string) => void) {
  const root = document.createElement('span');
  root.className = 'wm-thread-sizing';
  root.innerHTML = `<button type="button" class="wm-rail-button" title="Thread zoom" aria-label="Thread zoom" aria-expanded="false">${iconSvg('magnifying-glass-plus')}</button><span class="wm-thread-sizing-menu" hidden></span>`;
  const button = root.querySelector('button')!;
  const menu = root.querySelector<HTMLElement>('.wm-thread-sizing-menu')!;
  document.body.append(menu);
  let stopPlacement = () => {};
  const inputs = new Map<keyof Sizing, HTMLInputElement>();
  let queue = Promise.resolve();
  for (const [key, label, min, max, step] of [['uiScale', 'Interface scale', 70, 150, 5], ['commentTextSize', 'Comment text', 12, 24, 1]] as const) {
    const row = document.createElement('label');
    row.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.setAttribute('aria-label', label);
    const output = document.createElement('output');
    const show = () => { output.textContent = input.value + (key === 'uiScale' ? '%' : 'px'); };
    input.addEventListener('input', () => {
      show();
      document.documentElement.style.setProperty(key === 'uiScale' ? '--wm-ui-scale' : '--wm-comment-text-size', key === 'uiScale' ? String(Number(input.value) / 100) : `${input.value}px`);
    });
    input.addEventListener('change', () => {
      const value = Number(input.value) / (key === 'uiScale' ? 100 : 1);
      queue = queue.then(() => change({ [key]: value })).then(() => {}, error => notice(`Could not save thread zoom: ${String(error)}`));
    });
    row.append(input, output); menu.append(row); inputs.set(key, input);
  }
  const close = () => { stopPlacement(); menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => {
    if (!menu.hidden) { close(); return; }
    menu.hidden = false; button.setAttribute('aria-expanded', 'true');
    stopPlacement = placeOverlay(menu, { policy: 'pin', reference: () => button.isConnected ? button.getBoundingClientRect() : null });
  });
  const outside = (event: Event) => { if (event.target instanceof Node && !root.contains(event.target) && !menu.contains(event.target)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
  document.addEventListener('wm-before-rail-layout', close);
  return {
    root,
    update(value: Sizing) {
      for (const [key, input] of inputs) {
        if (document.activeElement === input) continue;
        input.value = String(key === 'uiScale' ? Math.round((value.uiScale ?? 1) * 100) : value.commentTextSize ?? 16);
        input.nextElementSibling!.textContent = input.value + (key === 'uiScale' ? '%' : 'px');
      }
    },
    destroy() { close(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); document.removeEventListener('wm-before-rail-layout', close); root.remove(); menu.remove(); },
  };
}
