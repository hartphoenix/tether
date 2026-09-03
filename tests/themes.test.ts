import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createThemePicker } from "../src/web/themes";

test("offers all bundled Crepe themes and applies the selection", () => {
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
    expect(menu.querySelectorAll("button")).toHaveLength(6);
    expect(root.dataset.wmTheme).toBe("frame-dark");
    menu.querySelector<HTMLButtonElement>('[data-theme="nord"]')!.click();
    expect(root.dataset.wmTheme).toBe("nord");
    expect(document.documentElement.dataset.wmTheme).toBe("nord");
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
