import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { RootContent, Definition } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);

/** Render Markdown to DOM without accepting executable HTML or loading remote images. */
export function renderCommentBody(source: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'wm-thread-body';
  const tree = parser.parse(source);
  const definitions = new Map<string, Definition>();
  for (const node of tree.children) if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node);
  const literal = (node: RootContent) => source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? source.length);
  const text = (value: string) => document.createTextNode(value);
  function link(url: string, children: Node[], title?: string | null): Node {
    const a = document.createElement('a');
    // Relative paths have no defined document scope inside a comment.
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      const span = document.createElement('span'); span.append(...children, text(` (${url})`)); return span;
    }
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    if (title) a.title = title;
    a.append(...children); return a;
  }
  function render(node: RootContent): Node {
    if (node.type === 'text') return text(node.value);
    if (node.type === 'break') return document.createElement('br');
    if (node.type === 'html') return text(node.value);
    if (node.type === 'definition') return text('');
    if (node.type === 'link') return link(node.url, node.children.map(render), node.title);
    if (node.type === 'linkReference') {
      const definition = definitions.get(node.identifier.toLowerCase());
      return definition ? link(definition.url, node.children.map(render), definition.title) : text(literal(node));
    }
    if (node.type === 'image') return link(node.url, [text(node.alt || 'Image')], node.title);
    if (node.type === 'imageReference') {
      const definition = definitions.get(node.identifier.toLowerCase());
      return definition ? link(definition.url, [text(node.alt || 'Image')], definition.title) : text(literal(node));
    }
    if (node.type === 'code') {
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = node.value; pre.append(code); return pre;
    }
    if (node.type === 'inlineCode') { const code = document.createElement('code'); code.textContent = node.value; return code; }
    if (node.type === 'table') {
      const wrapper = document.createElement('div'); wrapper.className = 'wm-comment-table';
      const table = document.createElement('table');
      node.children.forEach((row, index) => {
        const tr = document.createElement('tr');
        row.children.forEach((cell, column) => {
          const td = document.createElement(index === 0 ? 'th' : 'td');
          if (index === 0) td.setAttribute('scope', 'col');
          if (node.align?.[column]) td.style.textAlign = node.align[column]!;
          td.append(...cell.children.map(render)); tr.append(td);
        });
        table.append(tr);
      });
      wrapper.append(table); return wrapper;
    }
    const tags: Record<string, string> = { paragraph: 'p', strong: 'strong', emphasis: 'em', delete: 'del', blockquote: 'blockquote', thematicBreak: 'hr', listItem: 'li' };
    const tag = node.type === 'heading' ? `h${node.depth}` : node.type === 'list' ? node.ordered ? 'ol' : 'ul' : tags[node.type];
    if (!tag) return text(literal(node));
    const element = document.createElement(tag);
    if (node.type === 'list' && node.ordered && node.start != null) element.setAttribute('start', String(node.start));
    if (node.type === 'listItem' && node.checked != null) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = node.checked; check.disabled = true;
      check.setAttribute('aria-label', node.checked ? 'Completed' : 'Not completed'); element.className = 'wm-comment-task'; element.append(check);
    }
    if ('children' in node) element.append(...node.children.map(render));
    return element;
  }
  body.append(...tree.children.map(render));
  return body;
}
