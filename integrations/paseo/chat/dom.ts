/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// DOM selection and Markdown recovery adapted from Annotations/Quote (NOTICE.md).
import type { Anchor, Draft } from "./model";
import { composer, inputSelector, scope } from "./native";
export const transcriptSelector = '[data-testid="agent-chat-scroll"]';
export const ownSelector = '[data-tether-chat]';
export function element(node: Node): HTMLElement { return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as HTMLElement; }
export function inputAround(from: HTMLElement): HTMLTextAreaElement | null {
  for (let parent = from.parentElement; parent; parent = parent.parentElement) {
    const found = [...parent.querySelectorAll<HTMLTextAreaElement>(inputSelector)].filter(e => e.getClientRects().length);
    if (found.length === 1) return found[0];
    if (found.length > 1 || parent.matches('[data-testid^="workspace-pane-"]')) return null;
  }
  return null;
}
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => element(node).closest(`${ownSelector},[data-tether-submitted-source]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const result: Text[] = [];
  while (walker.nextNode()) result.push(walker.currentNode as Text);
  return result;
}
function rangeFor(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(root); let at = 0;
  const range = document.createRange(); let begun = false;
  for (const node of nodes) {
    if (!begun && start < at + node.length) { range.setStart(node, start - at); begun = true; }
    if (begun && end <= at + node.length) { range.setEnd(node, end - at); return range; }
    at += node.length;
  }
  return null;
}
export function findAnchor(transcript: HTMLElement, a: Anchor): Range | null {
  const roots = [...transcript.querySelectorAll<HTMLElement>('[data-message-id]')].filter(r => r.dataset.messageId === a.messageId);
  // Repeated virtualized rows must not produce a plausible but wrong highlight.
  const matches: Range[] = [];
  for (const root of roots) {
    const text = textNodes(root).map(n => n.data).join("");
    let start = a.start;
    if (text.slice(start, a.end) !== a.text || !text.slice(0, start).endsWith(a.prefix) || !text.slice(a.end).startsWith(a.suffix)) {
      const needle = a.prefix + a.text + a.suffix, at = text.indexOf(needle);
      if (at < 0 || text.indexOf(needle, at + 1) >= 0) continue;
      start = at + a.prefix.length;
    }
    const range = rangeFor(root, start, start + a.text.length);
    if (range) matches.push(range);
  }
  return matches.length === 1 ? matches[0] : null;
}
export type Passage = { key: string; input: HTMLTextAreaElement; draft: Draft; range: Range; rect: { left: number; top: number; right: number; bottom: number } };
export function visibleRect(range: Range): Passage["rect"] | null {
  let clip = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
  for (let node: HTMLElement | null = element(range.commonAncestorContainer); node; node = node.parentElement) {
    const style = getComputedStyle(node), r = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left); clip.right = Math.min(clip.right, r.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom); }
  }
  for (const r of range.getClientRects()) {
    const visible = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
    if (visible.right > visible.left && visible.bottom > visible.top) return visible;
  }
  return null;
}
export function readSelection(): Passage | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange(), start = element(range.startContainer), end = element(range.endContainer);
  if (start.closest(ownSelector) || end.closest(ownSelector)) return null;
  const transcript = start.closest<HTMLElement>(transcriptSelector);
  if (!transcript || !transcript.contains(end)) return null;
  const input = inputAround(transcript), c = input && composer(input), rect = visibleRect(range);
  if (!input || !c || !rect) return null;
  let quote = selection.toString();
  try {
    const data = new DataTransfer(), event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data });
    start.dispatchEvent(event);
    if (event.defaultPrevented && data.getData("text/plain").trim()) quote = data.getData("text/plain");
  } catch { /* Plain selected text remains usable. */ }
  const row = start.closest<HTMLElement>('[data-message-id]');
  let anchor: Anchor | undefined;
  if (row?.contains(end)) {
    const nodes = textNodes(row); let offset = 0, begin = -1, finish = -1;
    for (const node of nodes) {
      if (node === range.startContainer) begin = offset + range.startOffset;
      if (node === range.endContainer) finish = offset + range.endOffset;
      offset += node.length;
    }
    const text = nodes.map(n => n.data).join("");
    if (begin >= 0 && finish > begin) anchor = { messageId: row.dataset.messageId!, text: text.slice(begin, finish), start: begin, end: finish, prefix: text.slice(Math.max(0, begin - 48), begin), suffix: text.slice(finish, finish + 48) };
  }
  const code = element(range.commonAncestorContainer).closest('[data-paseo-markdown-tag="pre"],[data-paseo-markdown-tag="code"],[data-pmono]');
  const userBody = start.closest('[data-testid="user-message"]'), assistantBody = start.closest('[data-testid="assistant-message"]');
  const from = userBody?.contains(end) ? "user" : assistantBody?.contains(end) ? "assistant" : undefined;
  return { key: scope(c), input, range, rect, draft: { id: crypto.randomUUID(), quote, feedback: "", ...(anchor ? { anchor } : {}), ...(from ? { from } : {}), ...(code ? { code: code.getAttribute("data-paseo-markdown-language") || true } : {}), font: getComputedStyle(start).fontFamily } };
}
