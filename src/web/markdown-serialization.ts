import type { Ctx } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';

/** Milkdown's trailing-space shortcut bypasses escaping, including math delimiters. */
export function configureMarkdownSerialization(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, previous => {
    const text = previous.handlers?.text;
    return { ...previous, handlers: { ...previous.handlers, text(node, parent, state, info) {
      if (node.value.includes('$') || !text) return state.safe(node.value, { ...info, encode: [] });
      return text(node, parent, state, info);
    } } };
  });
}
