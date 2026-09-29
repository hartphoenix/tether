import { chipRing, builtInThemes, colorKeys, fontSlots, metrics, preferencesFrom, updatePreferences, builtInDesign, type BuiltInTheme, type CustomTheme, type Metric, type ThemeDesign, type ThemeId, type ThemeMutation, type ThemePreferences } from '../shared/themes';
import { createThemeMaker } from './theme-maker';
import { iconSvg } from './icons';
import { createFontLoader } from './theme-fonts';
export type CrepeTheme = ThemeId;

export function applyDesign(editorRoot: HTMLElement, base: BuiltInTheme, design?: ThemeDesign): void {
  const html = document.documentElement;
  html.dataset.wmTheme = editorRoot.dataset.wmTheme = base;
  for (const node of [html, editorRoot]) node.toggleAttribute('data-wm-designed', Boolean(design));
  for (const key of colorKeys) html.style.removeProperty(`--wm-color-${key}`);
  for (const slot of fontSlots) html.style.removeProperty(`--wm-font-${slot}`);
  for (const key of Object.keys(metrics)) html.style.removeProperty(`--wm-${key}`);
  html.style.removeProperty('--wm-page-background'); html.style.removeProperty('--wm-page-color');
  html.style.colorScheme = base.endsWith('-dark') ? 'dark' : 'light';
  if (!design) return;
  for (const key of ['annotation', 'selected'] as const) html.style.setProperty(`--wm-${key}-ring`, chipRing(design.colors, design.colors[key]));
  for (const key of colorKeys) html.style.setProperty(`--wm-color-${key}`, design.colors[key]);
  for (const slot of fontSlots) html.style.setProperty(`--wm-font-${slot}`, `"${design.fonts[slot].family}", ${design.fonts[slot].fallback}`);
  for (const key of Object.keys(metrics) as Metric[]) {
    const unit = ['px', 'em', 'ch'].includes(metrics[key].unit) ? metrics[key].unit : '';
    html.style.setProperty(`--wm-${key}`, `${design.metrics[key]}${unit}`);
  }
  html.style.setProperty('--wm-page-background', design.colors.background);
  html.style.setProperty('--wm-page-color', design.colors['on-background']);
}

export function createThemePicker(
  button: HTMLButtonElement, menu: HTMLElement, editorRoot: HTMLElement,
  options: {
    initialTheme?: ThemeId; customThemes?: CustomTheme[]; makerButton?: HTMLButtonElement; inheritPaseoTheme?: boolean;
    onChange?: (theme: ThemeId) => void;
    persist?: (mutation: ThemeMutation) => Promise<ThemePreferences>;
    onError?: (message: string) => void;
  } = {},
): { destroy(): void; update(preferences: ThemePreferences): void } {
  let state = preferencesFrom({ theme: options.initialTheme, customThemes: options.customThemes });
  let inherited = options.inheritPaseoTheme;
  let pending: ThemePreferences | undefined;
  let selected = state.theme;
  let busy = false;
  let destroyed = false;
  let diagramTheme = '';
  const fonts = createFontLoader();
  const designFor = (id: ThemeId) => builtInDesign(id) ?? state.customThemes.find(t => t.id === id);
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const preview = (design: ThemeDesign) => {
    applyDesign(editorRoot, design.base, design);
    for (const font of Object.values(design.fonts)) void fonts.load(font).catch(error => options.onError?.((error as Error).message));
    const signature = JSON.stringify([design.base, design.colors, design.fonts.code]);
    if (signature === diagramTheme) return;
    diagramTheme = signature;
    // Refresh previews after the code font can be measured, including diagrams still loading.
    void fonts.load(design.fonts.code).catch(() => {}).then(() => {
      if (destroyed || diagramTheme !== signature) return;
      for (const block of editorRoot.querySelectorAll('.milkdown-code-block .cm-editor')) {
        block.dispatchEvent(new editorRoot.ownerDocument.defaultView!.Event('milkdown:refresh-preview'));
      }
    });
  };
  const apply = (id: ThemeId) => {
    selected = id;
    const design = designFor(id);
    if (design) preview(design); else applyDesign(editorRoot, id as BuiltInTheme);
    const name = builtInThemes.find(t => t.value === id)?.label ?? state.customThemes.find(t => t.id === id)?.name ?? 'Tether';
    button.title = `Theme · ${inherited ? "Inherit Paseo theme · " : ""}${name}`; button.setAttribute('aria-label', button.title);
    menu.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(item => {
      item.classList.toggle('is-active', (!inherited && item.dataset.theme === id));
      item.setAttribute('aria-checked', String((!inherited && item.dataset.theme === id)));
    });
    const inheritButton = menu.querySelector<HTMLButtonElement>('[data-inherit-paseo]');
    inheritButton?.classList.toggle('is-active', inherited === true);
    inheritButton?.setAttribute('aria-checked', String(inherited === true));
  };
  function receive(next: ThemePreferences) {
    if (destroyed) return;
    if (busy || maker?.isOpen()) { pending = next; return; }
    pending = undefined;
    inherited = next.inheritPaseoTheme;
    state = preferencesFrom(next); renderMenu(); apply(state.theme);
  }
  const persist = async (mutation: ThemeMutation) => {
    if (busy) throw new Error('A theme save is already in progress.');
    busy = true; button.disabled = true;
    if (options.makerButton) options.makerButton.disabled = true;
    try {
      const next = options.persist ? await options.persist(mutation) : updatePreferences(state, mutation);
      if (destroyed) return;
      if (mutation.saveTheme && next.customThemes.find(t => t.id === mutation.saveTheme!.id)?.colors.annotation !== mutation.saveTheme.colors.annotation) {
        throw new Error('The service did not save the annotation color. Relaunch Tether and try again.');
      }
      pending = undefined;
      inherited = next.inheritPaseoTheme;
      state = preferencesFrom(next); renderMenu(); apply(state.theme);
      options.onChange?.(state.theme);
    } finally { busy = false; if (pending && !maker?.isOpen()) receive(pending); button.disabled = false; if (options.makerButton) options.makerButton.disabled = false; }
  };
  const maker = options.makerButton ? createThemeMaker(options.makerButton, {
    selected: () => selected,
    template: (id) => {
      return structuredClone(designFor(id)!);
    },
    library: () => state.customThemes,
    preview, restore: () => { if (pending) receive(pending); else apply(selected); }, loadFont: fonts.load,
    save: async (theme) => persist({ theme: theme.id, saveTheme: theme }),
    remove: async (id) => persist({ deleteTheme: id }),
  }) : undefined;
  function renderMenu() {
    menu.replaceChildren(...[...builtInThemes, ...state.customThemes.map(t => ({ value: t.id, label: t.name }))].map(({ value, label }) => {
      const item = document.createElement('button'); item.type = 'button'; item.dataset.theme = value;
      item.setAttribute('role', 'menuitemradio'); item.textContent = label;
      item.addEventListener('click', () => {
        if (busy || maker?.isOpen()) return;
        const previous = selected; apply(value); close();
        void persist({ theme: value }).catch(error => { apply(previous); options.onError?.(`Theme preference failed: ${(error as Error).message}`); });
      });
      const custom = state.customThemes.find(t => t.id === value);
      if (!custom || !maker) return item;
      const row = document.createElement('div'); row.className = 'wm-theme-row'; row.setAttribute('role', 'none');
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'wm-theme-edit';
      edit.dataset.editTheme = value; edit.setAttribute('role', 'menuitem');
      edit.title = `Edit ${label}`; edit.setAttribute('aria-label', edit.title); edit.innerHTML = iconSvg('pencil-simple-line');
      edit.addEventListener('click', () => { if (busy || maker.isOpen()) return; close(); maker.open(custom); });
      row.append(item, edit); return row;
    }));
    if (inherited !== undefined) {
      const item = document.createElement('button'); item.type = 'button'; item.dataset.inheritPaseo = 'true';
      item.textContent = 'Inherit Paseo theme'; item.setAttribute('role', 'menuitemradio');
      item.addEventListener('click', () => {
        if (busy || maker?.isOpen()) return;
        close(); void persist({ inheritPaseoTheme: true }).catch(error => options.onError?.(`Theme preference failed: ${(error as Error).message}`));
      });
      const separator = document.createElement('hr'); separator.setAttribute('role', 'separator');
      separator.style.cssText = 'width:100%;margin:4px 0;border:0;border-top:1px solid var(--crepe-color-outline);opacity:.3';
      menu.prepend(item, separator);
    }
  }
  menu.setAttribute('role', 'menu');
  const toggle = (event: Event) => {
    event.stopPropagation();
    if (maker?.isOpen()) return;
    menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden));
  };
  const outside = (event: Event) => { if (!(event.target instanceof Node) || (!menu.contains(event.target) && !button.contains(event.target))) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  button.addEventListener('click', toggle); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
  renderMenu(); apply(selected);
  return { update: receive, destroy() {
    destroyed = true; maker?.destroy(); fonts.destroy();
    button.removeEventListener('click', toggle); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
  } };
}
