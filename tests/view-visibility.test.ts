import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { observePaneVisibility } from "../integrations/paseo/client/view-visibility";

test("workspace and tab CSS hiding suspends only the affected pane, never an unfocused visible split", async () => {
  const dom = new JSDOM('<main><section><div id="pane"></div></section><input></main>', { pretendToBeVisual: true });
  const doc = dom.window.document, pane = doc.querySelector<HTMLElement>('#pane')!, section = pane.parentElement!;
  pane.getBoundingClientRect = () => ({ width: 500, height: 500 } as DOMRect);
  const states: boolean[] = [];
  const stop = observePaneVisibility(pane, value => states.push(value));
  try {
    expect(states).toEqual([true]);
    doc.querySelector('input')!.focus(); await Bun.sleep(0);
    expect(states).toEqual([true]);
    section.style.display = 'none'; await Bun.sleep(0);
    expect(states).toEqual([true, false]);
    section.style.display = 'flex'; await Bun.sleep(0);
    expect(states).toEqual([true, false, true]);
    Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    expect(states.at(-1)).toBe(false);
    stop();
    section.style.display = 'none'; await Bun.sleep(0);
    expect(states).toHaveLength(4);
  } finally { stop(); dom.window.close(); }
});
