import type { BlockProviderOptions, DeriveContext } from "@milkdown/kit/plugin/block";

function geometry({ active, editorDom, blockDom }: DeriveContext) {
  const block = active.el.getBoundingClientRect();
  const container = editorDom.parentElement!;
  const bounds = container.getBoundingClientRect();
  // Rects include zoom in modern engines, but not in older WebKit. Measure
  // everything in the same container's units instead of assuming either.
  const scale = bounds.width / container.offsetWidth || 1;
  const handleWidth = blockDom.getBoundingClientRect().width;
  const above = block.left - bounds.left < handleWidth + 24 * scale;
  return { block, scale, above };
}

export const blockHandle: Partial<BlockProviderOptions> = {
  getPlacement(context) {
    const { above } = geometry(context);
    context.blockDom.dataset.placement = above ? "above" : "margin";
    return above ? "top-start" : "left-start";
  },
  getPosition(context) {
    const { block, scale, above } = geometry(context);
    const style = context.active.el.ownerDocument.defaultView!.getComputedStyle(context.active.el);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const height = Math.min(block.height, (lineHeight || 28) * scale);
    // Center the controls on the first line, including multiline headings.
    const handleHeight = context.blockDom.getBoundingClientRect().height;
    const top = above ? block.top : block.top + (height - handleHeight) / 2;
    return { x: block.left, left: block.left, right: block.right, width: block.width,
      y: top, top, bottom: top + height, height };
  },
  floatingUIOptions: {
    // The normal flip middleware can put the handle to the right of a wide
    // paragraph. Choose the above-block fallback from the actual left gutter.
    middleware: [{
      name: "block-handle-gap",
      fn: ({ x, y, placement }) => ({ x: placement === "left-start" ? x - 16 : x, y }),
    }],
  },
};
