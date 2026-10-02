import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="editor"></div>', {url:'http://localhost',pretendToBeVisual:true});
const w = dom.window;
for(const key of ['window','document','navigator','Node','Element','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLDivElement','HTMLButtonElement','DocumentFragment','MutationObserver','DOMParser','getComputedStyle','Event','KeyboardEvent','MouseEvent','Range','ShadowRoot','SVGElement']) (globalThis as any)[key] = key === 'window' ? w : (w as any)[key];
(globalThis as any).requestAnimationFrame = w.requestAnimationFrame.bind(w);
(globalThis as any).cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
(globalThis as any).ResizeObserver = class {observe(){} unobserve(){} disconnect(){}};
(globalThis as any).IntersectionObserver = class {observe(){} unobserve(){} disconnect(){}};
Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);
Range.prototype.getClientRects = () => [] as any;
await import('../tests/browser/reader-regressions-fixture');
const api=(w as any).regressions;
const results = {prices:api.roundTrip('A \\$100 stock costs **only** \\$3. Buy the \\$110 call and sell the \\$130 call.\n\n`$code` and $x^2$.'),diff:api.diff('Old.\n\n```ts\nconst a = 1;\n```','New.\n\n```ts\nconst a = 1;\n```'),notes:api.diff('Old[^1].\n\n[^1]: A note.','New[^1].\n\n[^1]: A note.')};
try {
  const source = '# Hello, **world**!\n# Hello, world!\n# Hello, world!-1\n# Café 中文\n';
  const anchors = api.anchors(source);
  if (JSON.stringify(anchors) !== JSON.stringify(['hello-world','hello-world-1','hello-world-1-1','café-中文'])) throw new Error(JSON.stringify(anchors));
  if (JSON.stringify(api.anchors('# New!\n# New!')) !== JSON.stringify(['new','new-1'])) throw new Error('Heading IDs did not update after editing');
  if (results.prices.math !== 1 || !results.prices.markdown.includes('\\$100')) throw new Error(JSON.stringify(results.prices));
  for (const changes of [results.diff, results.notes]) if (changes.length !== 1 || changes[0].removed !== 'Old' || changes[0].added !== 'New') throw new Error(JSON.stringify(changes));
  console.log('Reader model regressions passed: heading anchors, escaped dollars, code-ending and footnote-ending diffs.');
} finally { await api.destroy(); dom.window.close(); }
