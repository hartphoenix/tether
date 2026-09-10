import { builtInThemes, bundledFonts, contrastRatio, fontSlots, metrics, validateCustomTheme, type CustomTheme, type FontSlot, type Metric, type ThemeColors, type ThemeDesign, type ThemeFont, type ThemeId } from '../shared/themes';
import { googleFontCandidates } from './theme-fonts';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text) node.textContent = text; return node;
}
function button(text: string, action: () => void) {
  const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node;
}
function label(text: string, input: HTMLElement) { input.setAttribute('aria-label', text); const node = element('label'); node.append(element('span', text), input); return node; }
function rgbToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) * 100, l * 100];
}
function hslToRgb([h, s, l]: number[]): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0'); };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function createThemeMaker(trigger: HTMLButtonElement, options: {
  selected(): ThemeId;
  template(id: ThemeId): ThemeDesign;
  library(): CustomTheme[];
  preview(design: ThemeDesign): void; restore(): void;
  save(theme: CustomTheme): Promise<void>; remove(id: string): Promise<void>;
  loadFont(font: ThemeFont): Promise<void>;
}) {
  const panel = element('aside'); panel.className = 'wm-theme-maker'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Theme maker');
  document.body.append(panel);
  trigger.setAttribute('aria-expanded', 'false');
  let draft: ThemeDesign;
  let basedOn: ThemeId, baseline = '';
  let saveButton: HTMLButtonElement;
  let confirmation: HTMLElement | undefined;
  const snapshot = () => JSON.stringify([draft, name.value.trim()]);
  const dirty = () => snapshot() !== baseline;
  const dismissConfirmation = () => { confirmation?.remove(); confirmation = undefined; };
  const confirm = (anchor: HTMLElement, title: string, actionLabel: string, action: () => void) => {
    dismissConfirmation();
    const popover = element('div'); popover.className = 'wm-maker-confirm';
    popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', title);
    const keep = button('Keep editing', () => { dismissConfirmation(); anchor.focus(); });
    const proceed = button(actionLabel, () => { dismissConfirmation(); action(); });
    popover.append(element('p', title), keep, proceed);
    anchor.parentElement!.append(popover); confirmation = popover; keep.focus();
  };
  const requestClose = (anchor: HTMLElement = trigger) => {
    if (busy) return;
    if (dirty()) confirm(anchor === trigger ? saveButton : anchor, 'Discard changes?', 'Discard', () => close());
    else close();
  };
  const updateSave = () => {
    const value = name.value.trim().toLocaleLowerCase();
    const duplicate = builtInThemes.some(t => t.label.toLocaleLowerCase() === value)
      || options.library().some(t => t.id !== saved?.id && t.name.toLocaleLowerCase() === value);
    name.setCustomValidity(duplicate ? 'Name already in use' : '');
    name.setAttribute('aria-invalid', String(duplicate));
    error.textContent = duplicate ? 'Name already in use' : '';
    saveButton.disabled = !value || duplicate || Boolean(saved && !dirty());
  };
  let saved: CustomTheme | undefined;
  let newThemeId: CustomTheme['id'];
  let busy = false, importing = false, generation = 0;
  let error: HTMLElement, contrast: HTMLElement, name: HTMLInputElement;
  let extraFonts: ThemeFont[] = [];
  const fontSelects = new Map<FontSlot, HTMLSelectElement>();
  const sliders = new Map<Metric, HTMLInputElement>();
  const close = (restore = true) => {
    if (busy) return;
    dismissConfirmation(); generation++; importing = false; panel.hidden = true; document.body.classList.remove('wm-making-theme'); trigger.setAttribute('aria-expanded', 'false');
    if (restore) options.restore(); trigger.focus();
  };
  const showError = (cause: unknown) => { error.textContent = (cause as Error).message; };
  const updateContrast = () => {
    const c = draft.colors;
    const ratios = [
      ['Text', contrastRatio(c['on-background'], c.background)],
      ['Links', contrastRatio(c.primary, c.background)],
      ['Inline code', contrastRatio(c['inline-code'], c['inline-area'])],
    ] as const;
    contrast.textContent = ratios.map(([name, ratio]) => `${name} ${ratio.toFixed(1)}:1${ratio < 4.5 ? ' · low' : ''}`).join(' / ');
  };
  const preview = () => { options.preview(draft); updateContrast(); updateSave(); };
  const withBusy = async (action: () => Promise<void>) => {
    if (busy || importing) return;
    busy = true; error.textContent = '';
    panel.querySelectorAll('fieldset').forEach(n => { n.disabled = true; });
    try { await action(); busy = false; close(false); }
    catch (cause) { showError(cause); }
    finally { busy = false; panel.querySelectorAll('fieldset').forEach(n => { n.disabled = false; }); }
  };
  function save() {
    updateSave(); if (saveButton.disabled) return;
    void withBusy(async () => {
      const theme = validateCustomTheme({ ...draft, id: saved ? saved.id : newThemeId, name: name.value });
      await options.save(theme);
    });
  }
  const addSlider = (parent: HTMLElement, key: Metric) => {
    const spec = metrics[key], input = element('input'), output = element('output');
    input.type = 'range'; input.min = String(spec.min); input.max = String(spec.max); input.step = String(spec.step); input.value = String(draft.metrics[key]);
    input.dataset.metric = key;
    const row = label(spec.label, input); row.append(output); parent.append(row); sliders.set(key, input);
    const sync = () => { output.value = `${Number(input.value)}${spec.unit}`; };
    input.addEventListener('input', () => { draft.metrics[key] = Number(input.value); sync(); preview(); }); sync();
  };
  const availableFonts = () => {
    const result = [...bundledFonts];
    for (const font of [...options.library().flatMap(t => Object.values(t.fonts)), ...Object.values(draft.fonts), ...extraFonts]) {
      if (!result.some(f => f.family === font.family && f.url === font.url)) result.push(font);
    }
    return result;
  };
  const fontKey = (f: ThemeFont) => JSON.stringify(f);
  const refreshFonts = () => {
    for (const [slot, select] of fontSelects) {
      select.replaceChildren(...availableFonts().map(font => {
        const option = element('option', `${font.family}${font.url ? ' · linked' : ''}`); option.value = fontKey(font); return option;
      }));
      select.value = fontKey(draft.fonts[slot]);
    }
  };
  const adjustWeight = (slot: FontSlot, notify = true) => {
    const key = `${slot}Weight` as Metric, input = sliders.get(key)!;
    const family = draft.fonts[slot].family;
    const min = family === 'Cabin' || family === 'Alegreya' ? 400 : metrics[key].min;
    const max = family === 'DM Mono' ? 500 : family === 'Cabin' ? Math.min(700, metrics[key].max) : metrics[key].max;
    const step = family === 'DM Mono' ? 100 : metrics[key].step;
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(Math.max(min, Math.min(max, Math.round(draft.metrics[key] / step) * step)));
    draft.metrics[key] = Number(input.value);
    input.parentElement!.querySelector('output')!.value = input.value;
    if (notify) preview();
  };
  const addColor = (parent: HTMLElement, key: keyof ThemeColors, title: string) => {
    const details = element('details'), summary = element('summary', title), swatch = element('input');
    swatch.type = 'color'; swatch.value = draft.colors[key]; swatch.setAttribute('aria-label', title); swatch.dataset.color = key;
    const hex = element('input'); hex.type = 'text'; hex.value = swatch.value; hex.maxLength = 7; hex.setAttribute('aria-label', `${title} hex color`);
    summary.append(element('span', 'Tune')); details.append(summary, label('Color', swatch), label('Hex', hex));
    let hsl = rgbToHsl(swatch.value);
    const ranges: HTMLInputElement[] = [], outputs: HTMLOutputElement[] = [];
    const update = (value: string) => {
      draft.colors[key] = value; swatch.value = hex.value = value;
      // Keep related chrome surfaces readable when document colors are changed.
      if (key === 'on-background') draft.colors['on-surface'] = value;
      preview();
    };
    ['Hue', 'Saturation', 'Lightness'].forEach((title, i) => {
      const input = element('input'), output = element('output'); input.type = 'range'; input.min = '0'; input.max = i === 0 ? '360' : '100'; input.step = '1'; input.value = String(Math.round(hsl[i])); output.value = input.value;
      const row = label(title, input); row.append(output); details.append(row); ranges.push(input); outputs.push(output);
      input.addEventListener('input', () => { hsl[i] = Number(input.value); output.value = input.value; update(hslToRgb(hsl)); });
    });
    const sync = (value: string) => { hsl = rgbToHsl(value); ranges.forEach((r, i) => { r.value = String(Math.round(hsl[i])); outputs[i].value = r.value; }); update(value); };
    swatch.addEventListener('input', () => sync(swatch.value));
    hex.addEventListener('change', () => { if (/^#[\da-f]{6}$/i.test(hex.value)) { hex.setCustomValidity(''); sync(hex.value); } else { hex.setCustomValidity('Use six hex digits, such as #29323d.'); hex.reportValidity(); } });
    parent.append(details);
  };
  function open(edit?: CustomTheme) {
    if (busy) return;
    if (!panel.hidden) { requestClose(); return; }
    saved = edit;
    newThemeId = `custom-${crypto.randomUUID()}`;
    basedOn = edit?.id ?? options.selected();
    draft = options.template(basedOn);
    render();
  }
  function render() {
    dismissConfirmation(); generation++; importing = false; extraFonts = []; fontSelects.clear(); sliders.clear();
    panel.replaceChildren();
    const header = element('header'); header.append(element('h2', saved ? 'Edit theme' : 'Theme maker'));
    error = element('p'); error.className = 'wm-maker-error'; error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
    contrast = element('p'); contrast.className = 'wm-maker-contrast';
    const fields = element('fieldset');
    name = element('input'); name.type = 'text'; name.maxLength = 64; name.value = saved?.name ?? `My ${builtInThemes.find(t => t.value === draft.base)?.label}`;
    if (!saved) {
      const select = element('select');
      for (const theme of [...builtInThemes, ...options.library().map(t => ({ value: t.id, label: t.name }))]) {
        const option = element('option', theme.label); option.value = theme.value; select.append(option);
      }
      select.value = basedOn;
      select.addEventListener('change', () => {
        const next = select.value as ThemeId; select.value = basedOn;
        const load = () => { basedOn = next; draft = options.template(next); render(); options.preview(draft); };
        if (dirty()) confirm(select, 'Discard changes?', 'Discard', load); else load();
      });
      fields.append(label('Based on', select));
      const templateName = options.library().find(t => t.id === basedOn)?.name ?? builtInThemes.find(t => t.value === basedOn)?.label;
      let proposed = `My ${templateName}`.slice(0, 60), suffix = 2;
      const occupied = () => options.library().some(t => t.name.toLocaleLowerCase() === proposed.toLocaleLowerCase());
      const stem = proposed;
      while (occupied()) proposed = `${stem} ${suffix++}`;
      name.value = proposed;
    }
    name.addEventListener('input', updateSave);
    fields.append(label('Theme name', name));
    const groups: Record<FontSlot, Metric[]> = {
      heading: ['headingSize', 'headingWeight', 'headingSpacing'],
      body: ['bodySize', 'bodyWeight', 'bodySpacing', 'lineHeight', 'paragraphGap', 'lineWidth'],
      code: ['codeSize', 'codeWeight', 'codeLineHeight'],
    };
    for (const slot of fontSlots) {
      const group = element('details'); group.open = slot === 'body'; group.append(element('summary', slot === 'heading' ? 'Headings' : slot === 'body' ? 'Paragraphs' : 'Code'));
      const select = element('select'); select.dataset.fontSlot = slot; fontSelects.set(slot, select); group.append(label('Font family', select));
      select.addEventListener('change', () => { draft.fonts[slot] = JSON.parse(select.value) as ThemeFont; adjustWeight(slot); });
      for (const key of groups[slot]) addSlider(group, key);
      if (slot === 'code') group.append(element('p', 'DM Mono has three weights: 300, 400, and 500. Other static fonts use the closest available weight.'));
      fields.append(group);
    }
    refreshFonts();
    for (const slot of fontSlots) adjustWeight(slot, false);
    const colors = element('details'); colors.append(element('summary', 'Colors'), contrast, element('p', 'Aim for at least 4.5:1 for ordinary text. Contrast is one measure of readability.'));
    for (const [key, title] of [['background', 'Page'], ['on-background', 'Text'], ['primary', 'Links & accent'], ['inline-code', 'Inline code'], ['inline-area', 'Inline code background'], ['surface', 'Code & toolbar background'], ['hover', 'Active code line & toolbar hover'], ['on-surface-variant', 'Secondary text'], ['selected', 'Selection'], ['annotation', 'Annotation highlight']] as const) addColor(colors, key, title);
    fields.append(colors);
    const imports = element('details'); imports.append(element('summary', 'Import Google Font'), element('p', 'Bundled fonts work offline. Linking another font contacts Google when it loads and needs a connection on first use.'));
    const input = element('input'); input.type = 'text'; input.placeholder = 'Literata, specimen link, or CSS2 URL';
    const target = element('select'); for (const slot of fontSlots) { const option = element('option', slot === 'body' ? 'Paragraphs' : slot === 'heading' ? 'Headings' : 'Code'); option.value = slot; target.append(option); } target.value = 'body';
    const importedStatus = element('p'); importedStatus.setAttribute('role', 'status');
    const importButton = button('Link font', () => {
      if (importing) return;
      importing = true; importButton.disabled = true; const version = generation;
      importedStatus.textContent = 'Loading…';
      void (async () => {
        const { family, urls } = googleFontCandidates(input.value);
        let lastError: unknown;
        for (let i = 0; i < urls.length; i++) {
          const font: ThemeFont = { family, fallback: target.value === 'code' ? 'monospace' : 'serif', url: urls[i] };
          try {
            await options.loadFont(font);
            if (version !== generation) return;
            const slot = target.value as FontSlot;
            extraFonts.push(font); draft.fonts[slot] = font; refreshFonts(); adjustWeight(slot);
            importedStatus.textContent = i === 2 ? `${family} linked (regular only). Paste a CSS2 URL to request other styles.` : `${family} linked. Save the theme to keep it. For continuous weight control, paste a variable-font CSS2 URL.`;
            return;
          } catch (cause) { lastError = cause; if (version !== generation) return; }
        }
        throw lastError;
      })().catch(cause => { if (version === generation) importedStatus.textContent = (cause as Error).message; }).finally(() => { if (version === generation) importing = false; importButton.disabled = false; });
    });
    imports.append(label('Font', input), label('Use for', target), importButton, importedStatus); fields.append(imports);
    const actions = element('fieldset'); actions.className = 'wm-maker-actions';
    saveButton = button(saved ? 'Save changes' : 'Save theme', save);
    const cancel = button('Cancel', () => requestClose(cancel));
    actions.append(saveButton, cancel);
    if (saved) {
      const remove = button('Delete theme', () => confirm(remove, `Delete “${saved!.name}”?`, 'Delete', () => { void withBusy(() => options.remove(saved!.id)); }));
      remove.className = 'wm-maker-delete'; actions.append(remove);
    }
    panel.append(header, error, fields, actions);
    baseline = snapshot(); updateSave();
    panel.hidden = false; document.body.classList.add('wm-making-theme'); trigger.setAttribute('aria-expanded', 'true'); updateContrast(); name.focus();
    if (saved) options.preview(draft);
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    if (confirmation) { dismissConfirmation(); saveButton.focus(); } else requestClose();
  };
  const toggle = () => open();
  trigger.addEventListener('click', toggle); document.addEventListener('keydown', escape);
  return { open, isOpen: () => !panel.hidden, destroy() { generation++; trigger.removeEventListener('click', toggle); document.removeEventListener('keydown', escape); panel.remove(); document.body.classList.remove('wm-making-theme'); } };

}
