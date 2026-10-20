import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createTurnControls } from "../src/web/turn-button";

test("empty Go copies assignment; context menu offers rename and takeover without sending a turn", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const keys = ["document", "Event", "innerWidth", "innerHeight"] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  try {
    let presses = 0, copies = 0, renames = 0, copiedId: string | undefined;
    const controls = createTurnControls({
      request: async () => { presses++; throw new Error("Unexpected send"); },
      notice: () => {},
      rename: () => { renames++; },
      copyAssignment: async agent => { copies++; copiedId = agent?.agentId; },
    });
    document.body.append(controls.root);
    const placeholder = controls.root.querySelector("button")!;
    expect(placeholder.disabled).toBe(false);
    placeholder.click();
    await Promise.resolve();
    expect(copies).toBe(1);
    expect(copiedId).toBeUndefined();
    controls.update([{ agentId: "paseo:a", state: "ready" }]);
    const button = controls.root.querySelectorAll("button")[1]!;
    button.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    const menu = document.querySelector('[role="menu"]')!;
    const actions = menu.querySelectorAll("button");
    expect(Array.from(actions, item => item.textContent)).toEqual(["Rename agent…", "Copy role takeover prompt"]);
    actions[1]!.click();
    await Promise.resolve();
    expect(copies).toBe(2);
    expect(copiedId).toBe("paseo:a");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true }));
    (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(renames).toBe(1);
    expect(presses).toBe(0);
  } finally {
    keys.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});
