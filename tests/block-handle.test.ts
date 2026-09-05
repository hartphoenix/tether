import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { DeriveContext } from "@milkdown/kit/plugin/block";
import { blockHandle } from "../src/web/block-handle";

function context(gutter: number, rectScale: number): DeriveContext {
  const dom = new JSDOM('<div><article><p style="line-height: 28px">Passage</p></article><aside></aside></div>');
  const container = dom.window.document.querySelector('div')!;
  const editorDom = dom.window.document.querySelector('article')!;
  const el = dom.window.document.querySelector('p')!;
  const blockDom = dom.window.document.querySelector('aside')!;
  // Nonzero container origin catches accidental viewport-based gutter checks.
  container.getBoundingClientRect = () => new dom.window.DOMRect(100, 50, 800 * rectScale, 900 * rectScale);
  Object.defineProperty(container, "offsetWidth", { value: 800 });
  el.getBoundingClientRect = () => new dom.window.DOMRect(100 + gutter * rectScale, 400 * rectScale, 600 * rectScale, 140 * rectScale);
  blockDom.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 66 * rectScale, 32 * rectScale);
  return { editorDom, blockDom, active: { el } } as unknown as DeriveContext;
}

test("keeps the handle beside the first line across zoom measurement conventions", () => {
  // Old WebKit returns unscaled rects; modern engines return scaled rects.
  for (const scale of [1, 0.75, 0.85, 1.2, 1.75]) {
    const input = context(120, scale);
    expect(blockHandle.getPlacement!(input)).toBe("left-start");
    const rect = blockHandle.getPosition!(input);
    expect(rect.top + 16 * scale).toBeCloseTo((400 + 14) * scale);
  }
});

test("uses an above-block fallback for both desktop and mobile padding", () => {
  for (const scale of [0.85, 1, 1.2]) {
    for (const gutter of [20, 44]) {
      const input = context(gutter, scale);
      expect(blockHandle.getPlacement!(input)).toBe("top-start");
      expect(input.blockDom.dataset.placement).toBe("above");
      expect(blockHandle.getPosition!(input).top).toBe(400 * scale);
      expect(blockHandle.getPosition!(input).left).toBe(100 + gutter * scale);
    }
  }
});

test("returns to the margin when the document has enough space again", () => {
  const input = context(44, 1.2);
  expect(blockHandle.getPlacement!(input)).toBe("top-start");
  input.active.el.getBoundingClientRect = context(120, 1.2).active.el.getBoundingClientRect;
  expect(blockHandle.getPlacement!(input)).toBe("left-start");
  expect(input.blockDom.dataset.placement).toBe("margin");
});
