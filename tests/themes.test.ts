import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createThemePicker } from "../src/web/themes";

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
    expect(menu.querySelectorAll("button")).toHaveLength(8);
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
  let state = preferencesFrom(null), fail = false;
  try {
    const picker = createThemePicker(document.querySelector('#picker')!, document.querySelector('#menu')!, document.querySelector('main')!, {
      makerButton: document.querySelector<HTMLButtonElement>('#maker')!,
      persist: async mutation => { if (fail) throw new Error('Disk full'); state = updatePreferences(state, mutation); return state; },
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
    expect(document.documentElement.style.getPropertyValue('--wm-bodySize')).toBe('19px');
    expect(state.customThemes).toHaveLength(0);
    open(); change(); click('Save theme');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel().hidden).toBe(true); expect(state.customThemes).toHaveLength(1);
    expect(state.customThemes[0].metrics.bodySize).toBe(22);
    expect(document.querySelectorAll('#menu button')).toHaveLength(9);
    open(); fail = true; click('Save changes');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel().hidden).toBe(false); expect(panel().textContent).toContain('Disk full');
    click('Cancel'); picker.destroy();
  } finally { globalThis.document = previousDocument; globalThis.Node = previousNode; }
});
