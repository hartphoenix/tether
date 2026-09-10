import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderCommentBody } from '../src/web/comment-body';

test('comments render Markdown, soft breaks, nested lists, code indentation and task state', () => {
  const previous = globalThis.document; globalThis.document = new JSDOM().window.document;
  try {
    const node = renderCommentBody('First line\nSecond line\n\n**Bold** and *italic* and ~~removed~~.\n\n- one\n  - nested\n- [x] done\n\n```ts\n  const x = 1;\n\treturn x;\n```\n\n| One | Two |\n| --- | --- |\n| a | b |');
    expect(node.querySelector('p')!.textContent).toBe('First line\nSecond line');
    expect(node.querySelector('strong')!.textContent).toBe('Bold');
    expect(node.querySelector('em')!.textContent).toBe('italic');
    expect(node.querySelector('del')!.textContent).toBe('removed');
    expect(node.querySelector('ul ul li')!.textContent).toBe('nested');
    expect(node.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(node.querySelector('pre code')!.textContent).toBe('  const x = 1;\n\treturn x;');
    expect(node.querySelectorAll('th')).toHaveLength(2);
  } finally { globalThis.document = previous; }
});

test('comments never execute raw HTML, unsafe links, or load remote images', () => {
  const previous = globalThis.document; globalThis.document = new JSDOM().window.document;
  try {
    const node = renderCommentBody('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [good](https://example.com) ![diagram](https://example.com/image.png)');
    expect(node.querySelector('script, img')).toBeNull();
    expect(node.textContent).toContain('<script>alert(1)</script>');
    expect([...node.querySelectorAll('a')].every(a=>a.href.startsWith('https://'))).toBe(true);
    expect(node.querySelector('a')!.rel).toBe('noopener noreferrer');
  } finally { globalThis.document = previous; }
});
