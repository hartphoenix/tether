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

test("offers all bundled Crepe themes and applies the selection", async () => {
  const dom = new JSDOM("<!doctype html><button></button><div></div><main></main>", { url: "http://localhost" });
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  try {
    const button = document.querySelector("button")!;
    const menu = document.querySelector("div")!;
    const root = document.querySelector("main")!;
    let selected = "frame-dark";
    const picker = createThemePicker(button, menu, root, { onChange: (theme) => { selected = theme; } });
    expect([...menu.querySelectorAll('button')].map(item => item.textContent)).toEqual([
      'Tether Light', 'Tether Dark', 'Light Treason', 'Dark Academia',
      'Frame Light', 'Frame Dark', 'Crepe Light', 'Crepe Dark', 'Nord Light', 'Nord Dark',
    ]);
    for (const id of ['tether', 'tether-dark', 'light-treason', 'dark-academia'] as const) {
      menu.querySelector<HTMLButtonElement>(`[data-theme="${id}"]`)!.click();
      await Promise.resolve();
      const design = builtInDesign(id)!;
      expect(document.documentElement.style.getPropertyValue('--wm-color-background')).toBe(design.colors.background);
      expect(document.documentElement.style.colorScheme).toBe(design.base.endsWith('-dark') ? 'dark' : 'light');
    }
    menu.querySelector<HTMLButtonElement>('[data-theme="tether-dark"]')!.click();
    await Promise.resolve();
    expect(root.dataset.wmTheme).toBe("tether-dark");
    menu.querySelector<HTMLButtonElement>('[data-theme="nord"]')!.click();
    expect(root.dataset.wmTheme).toBe("nord");
    expect(document.documentElement.dataset.wmTheme).toBe("nord");
    await Promise.resolve();
    expect(selected).toBe("nord");
    picker.destroy();

    const nextButton = document.createElement("button");
    const nextMenu = document.createElement("div");
    const nextRoot = document.createElement("main");
    const nextPicker = createThemePicker(nextButton, nextMenu, nextRoot, { initialTheme: "nord" });
    expect(nextRoot.dataset.wmTheme).toBe("nord");
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
      size.value = '22'; size.dispatchEvent(new dom.window.Event('input'));
    };
    open(); change();
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('22px');
    click('Cancel');
    expect(panel().hidden).toBe(false); click('Discard');
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('20px');
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
    expect(state.customThemes[0].metrics.bodySize).toBe(22);
    expect(state.customThemes[0].colors.annotation).toBe('#aa44cc');
    expect(document.querySelectorAll('#menu button[data-theme]')).toHaveLength(11);
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
    open();
    const basedOn = () => panel().querySelector<HTMLSelectElement>('[aria-label="Based on"]')!;
    expect(basedOn().value).toBe(state.customThemes[0].id);
    expect(basedOn().options).toHaveLength(11);
    const size = panel().querySelector<HTMLInputElement>('[data-metric="bodySize"]')!;
    size.value = '25'; size.dispatchEvent(new dom.window.Event('input'));
    basedOn().value = 'tether'; basedOn().dispatchEvent(new dom.window.Event('change'));
    click('Keep editing'); expect(basedOn().value).toBe(state.customThemes[0].id);
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('25px');
    basedOn().value = 'tether'; basedOn().dispatchEvent(new dom.window.Event('change'));
    click('Discard'); expect(basedOn().value).toBe('tether');
    expect(document.documentElement.dataset.wmTheme).toBe('tether');
    expect(panel().querySelector<HTMLInputElement>('[data-metric="bodySize"]')!.value).toBe('20');
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
