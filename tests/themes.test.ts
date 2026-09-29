import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createThemePicker } from "../src/web/themes";
import { builtInDesign, builtInThemes, tetherDesign, preferencesFrom, validateCustomTheme } from '../src/shared/themes';

test('older custom themes inherit yellow annotations and preserve a chosen color', () => {
  for (const dark of [false, true]) {
    const theme = { ...tetherDesign(dark), id: 'custom-legacy' as const, name: 'Legacy' };
    const expected = dark ? '#ffbe3e' : '#f1be5c';
    expect(theme.colors.annotation).toBe(expected);
    const legacy = JSON.parse(JSON.stringify(theme));
    delete legacy.colors.annotation;
    const restored = preferencesFrom({ theme: theme.id, customThemes: [legacy] });
    expect(restored.theme).toBe(theme.id);
    expect(restored.customThemes[0].colors.annotation).toBe(expected);
    legacy.colors.annotation = '#aa44cc';
    expect(validateCustomTheme(legacy).colors.annotation).toBe('#aa44cc');
    legacy.colors.annotation = 'invalid';
    expect(() => validateCustomTheme(legacy)).toThrow('Invalid color: annotation');
  }
});

test('theme changes refresh code previews once without rebuilding editor content', async () => {
  const dom = new JSDOM('<button></button><div></div><main><section class="milkdown-code-block"><div class="cm-editor"></div></section></main>');
  const previousDocument = globalThis.document, previousNode = globalThis.Node;
  globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
  try {
    const root = document.querySelector('main')!;
    const block = root.querySelector('.cm-editor')!;
    let refreshes = 0;
    block.addEventListener('milkdown:refresh-preview', () => refreshes++);
    const picker = createThemePicker(document.querySelector('button')!, document.querySelector('div')!, root, { initialTheme: 'tether' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const initial = refreshes;
    picker.update(preferencesFrom({ theme: 'tether-dark' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(initial + 1);
    picker.update(preferencesFrom({ theme: 'tether-dark' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(initial + 1);
    expect(root.querySelector('.cm-editor')).toBe(block);
    picker.update(preferencesFrom({ theme: 'tether' }));
    picker.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(initial + 1);
  } finally {
    globalThis.document = previousDocument; globalThis.Node = previousNode;
  }
});

test("offers the built-in themes in order and applies each selection", async () => {
  const dom = new JSDOM("<!doctype html><button></button><div></div><main></main>", { url: "http://localhost" });
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  try {
    const button = document.querySelector("button")!;
    const menu = document.querySelector("div")!;
    const root = document.querySelector("main")!;
    let selected = "tether-dark";
    const picker = createThemePicker(button, menu, root, { onChange: (theme) => { selected = theme; } });
    expect([...menu.querySelectorAll('button')].map(item => item.textContent)).toEqual([
      'Tether Light', 'Tether Dark', 'Light Treason', 'Dark Academia',
      'Paseo Light', 'Paseo Dark', 'Paseo Zinc', 'Paseo Midnight', 'Paseo Claude', 'Paseo Ghostty', 'Paseo Pure Black',
    ]);
    for (const { value: id } of builtInThemes) {
      menu.querySelector<HTMLButtonElement>(`[data-theme="${id}"]`)!.click();
      await Promise.resolve();
      const design = builtInDesign(id)!;
      expect(document.documentElement.style.getPropertyValue('--wm-color-background')).toBe(design.colors.background);
      expect(document.documentElement.style.colorScheme).toBe(design.base.endsWith('-dark') ? 'dark' : 'light');
    }
    menu.querySelector<HTMLButtonElement>('[data-theme="tether-dark"]')!.click();
    await Promise.resolve();
    expect(root.dataset.wmTheme).toBe("tether-dark");
    menu.querySelector<HTMLButtonElement>('[data-theme="tether"]')!.click();
    expect(root.dataset.wmTheme).toBe("tether");
    expect(document.documentElement.dataset.wmTheme).toBe("tether");
    await Promise.resolve();
    expect(selected).toBe("tether");
    picker.destroy();

    const nextButton = document.createElement("button");
    const nextMenu = document.createElement("div");
    const nextRoot = document.createElement("main");
    const nextPicker = createThemePicker(nextButton, nextMenu, nextRoot, { initialTheme: "tether" });
    expect(nextRoot.dataset.wmTheme).toBe("tether");
    nextPicker.destroy();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
});

test('maker previews, cancels, saves, and retains draft on failed persistence', async () => {
  const dom = new JSDOM('<!doctype html><button id="picker"></button><div id="menu"></div><button id="maker"></button><main><div class="milkdown"></div></main>', { url: 'http://localhost' });
  const previousDocument = globalThis.document, previousNode = globalThis.Node;
  globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
  const { preferencesFrom, updatePreferences } = await import('../src/shared/themes');
  let state = preferencesFrom(null), fail = false, legacyResponse = false;
  try {
    const picker = createThemePicker(document.querySelector('#picker')!, document.querySelector('#menu')!, document.querySelector('main')!, {
      makerButton: document.querySelector<HTMLButtonElement>('#maker')!,
      persist: async mutation => {
        if (fail) throw new Error('Disk full');
        state = updatePreferences(state, mutation);
        const response = structuredClone(state);
        if (legacyResponse) response.customThemes.forEach(theme => Reflect.deleteProperty(theme.colors, 'annotation'));
        return response;
      },
    });
    const open = () => document.querySelector<HTMLButtonElement>('#maker')!.click();
    const panel = () => document.querySelector<HTMLElement>('.wm-theme-maker')!;
    const click = (text: string) => [...panel().querySelectorAll('button')].find(b => b.textContent === text)!.click();
    const change = () => {
      const size = panel().querySelector<HTMLInputElement>('[data-metric="bodySize"]')!;
      size.value = '14'; size.dispatchEvent(new dom.window.Event('input'));
    };
    open(); change();
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe(`${14 * 4 / 3}px`);
    click('Cancel');
    expect(panel().hidden).toBe(false); click('Discard');
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('16px');
    expect(state.customThemes).toHaveLength(0);
    open(); change();
    const annotation = panel().querySelector<HTMLInputElement>('[data-color="annotation"]')!;
    annotation.value = '#aa44cc'; annotation.dispatchEvent(new dom.window.Event('input'));
    expect(document.documentElement.style.getPropertyValue('--wm-color-annotation')).toBe('#aa44cc');
    legacyResponse = true;
    click('Save theme');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain('The service did not save the annotation color');
    expect(annotation.value).toBe('#aa44cc');
    legacyResponse = false;
    click('Save theme');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel().hidden).toBe(true); expect(state.customThemes).toHaveLength(1);
    expect(state.customThemes[0].metrics.bodySize).toBe(14 * 4 / 3);
    expect(state.customThemes[0].colors.annotation).toBe('#aa44cc');
    expect(document.querySelectorAll('#menu button[data-theme]')).toHaveLength(builtInThemes.length + 1);
    document.querySelector<HTMLButtonElement>('[data-edit-theme]')!.click();
    expect(panel().querySelector('[aria-label="Based on"]')).toBeNull();
    const save = [...panel().querySelectorAll('button')].find(b => b.textContent === 'Save changes')!;
    expect(save.disabled).toBe(true);
    const name = panel().querySelector<HTMLInputElement>('[aria-label="Theme name"]')!;
    name.value = ' tether light '; name.dispatchEvent(new dom.window.Event('input'));
    expect(save.disabled).toBe(true); expect(panel().textContent).toContain('Name already in use');
    name.value = 'Renamed'; name.dispatchEvent(new dom.window.Event('input'));
    expect(save.disabled).toBe(false);
    fail = true; click('Save changes');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel().hidden).toBe(false); expect(panel().textContent).toContain('Disk full');
    click('Cancel'); click('Keep editing'); expect(panel().hidden).toBe(false);
    fail = false; click('Save changes'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.customThemes).toHaveLength(1); expect(state.customThemes[0].name).toBe('Renamed');
    expect(state.customThemes[0].metrics.bodySize).toBe(14 * 4 / 3);
    open();
    const basedOn = () => panel().querySelector<HTMLSelectElement>('[aria-label="Based on"]')!;
    expect(basedOn().value).toBe(state.customThemes[0].id);
    expect(basedOn().options).toHaveLength(builtInThemes.length + 1);
    const size = panel().querySelector<HTMLInputElement>('[data-metric="bodySize"]')!;
    size.value = '15'; size.dispatchEvent(new dom.window.Event('input'));
    basedOn().value = 'tether'; basedOn().dispatchEvent(new dom.window.Event('change'));
    click('Keep editing'); expect(basedOn().value).toBe(state.customThemes[0].id);
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('20px');
    basedOn().value = 'tether'; basedOn().dispatchEvent(new dom.window.Event('change'));
    click('Discard'); expect(basedOn().value).toBe('tether');
    expect(document.documentElement.dataset.wmTheme).toBe('tether');
    expect(panel().querySelector<HTMLInputElement>('[data-metric="bodySize"]')!.value).toBe('12');
    click('Cancel'); expect(panel().hidden).toBe(true);
    expect(document.documentElement.dataset.wmTheme).toBe(state.customThemes[0].base);
    document.querySelector<HTMLButtonElement>('[data-edit-theme]')!.click();
    click('Delete theme'); click('Keep editing'); expect(state.customThemes).toHaveLength(1);
    click('Delete theme'); click('Delete'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.customThemes).toHaveLength(0); expect(state.theme).toBe('tether-dark');
    picker.destroy();
  } finally { globalThis.document = previousDocument; globalThis.Node = previousNode; }
});

test('original presets are valid, isolated templates and reserved system names', async () => {
  const { updatePreferences } = await import('../src/shared/themes');
  for (const { value, label } of builtInThemes.slice(0, 4)) {
    const design = builtInDesign(value)!;
    expect(validateCustomTheme({ ...design, id: 'custom-copy', name: 'Copy' }).colors).toEqual(design.colors);
    design.colors.background = '#000000';
    expect(builtInDesign(value)!.colors.background).not.toBe('#000000');
    expect(() => updatePreferences(preferencesFrom(null), { saveTheme: { ...design, id: 'custom-copy', name: label } })).toThrow('name is already in use');
    expect(preferencesFrom({ theme: value }).theme).toBe(value);
  }
});

test('Paseo inheritance appears first, stays selected through live updates, and manual selection leaves it', async () => {
  const dom = new JSDOM('<button></button><div></div><main></main>', { url: 'http://localhost' });
  const previousDocument = globalThis.document, previousNode = globalThis.Node;
  globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
  try {
    const button = document.querySelector('button')!, menu = document.querySelector('div')!, root = document.querySelector('main')!;
    const picker = createThemePicker(button, menu, root, {
      inheritPaseoTheme: false,
      persist: async mutation => ({ theme: mutation.inheritPaseoTheme ? 'paseo-claude' : mutation.theme!, customThemes: [], inheritPaseoTheme: mutation.inheritPaseoTheme === true }),
    });
    expect(menu.firstElementChild?.textContent).toBe('Inherit Paseo theme');
    expect(menu.children[1].getAttribute('role')).toBe('separator');
    (menu.firstElementChild as HTMLButtonElement).click(); await Promise.resolve();
    expect(menu.firstElementChild?.getAttribute('aria-checked')).toBe('true');
    picker.update({ theme: 'paseo-midnight', customThemes: [], inheritPaseoTheme: true });
    expect(document.documentElement.style.getPropertyValue('--wm-color-background')).toBe(builtInDesign('paseo-midnight')!.colors.background);
    expect(menu.querySelector('[data-theme="paseo-midnight"]')?.getAttribute('aria-checked')).toBe('false');
    menu.querySelector<HTMLButtonElement>('[data-theme="tether"]')!.click(); await Promise.resolve();
    expect(menu.firstElementChild?.getAttribute('aria-checked')).toBe('false');
    expect(menu.querySelector('[data-theme="tether"]')?.getAttribute('aria-checked')).toBe('true');
    picker.destroy();
  } finally { globalThis.document = previousDocument; globalThis.Node = previousNode; dom.window.close(); }
});

test('opening and saving unrelated theme edits preserves fractional pixel sizes', async () => {
  const { createThemeMaker } = await import('../src/web/theme-maker');
  const dom = new JSDOM('<!doctype html><button></button>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const theme = { ...tetherDesign(false), id: 'custom-fractional' as const, name: 'Fractional' };
  theme.metrics = { ...theme.metrics, headingSize: 31.123456789, bodySize: 17.123456789, codeSize: 12.123456789 };
  let saved: import('../src/shared/themes').CustomTheme | undefined;
  const maker = createThemeMaker(document.querySelector('button')!, {
    selected: () => theme.id, template: () => structuredClone(theme), library: () => [theme],
    preview: () => {}, restore: () => {}, save: async value => { saved = value; }, remove: async () => {}, loadFont: async () => {},
  });
  try {
    maker.open(theme);
    const name = document.querySelector<HTMLInputElement>('[aria-label="Theme name"]')!;
    name.value = 'Renamed'; name.dispatchEvent(new dom.window.Event('input'));
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Save changes')!.click();
    await Promise.resolve();
    expect(saved!.metrics).toEqual(theme.metrics);
  } finally { maker.destroy(); globalThis.document = previous; }
});
