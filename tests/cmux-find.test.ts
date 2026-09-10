import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { installCmuxFindCompatibility } from "../src/web/hosts/cmux-find";

function environment() {
  const dom = new JSDOM('<!doctype html><div id="editor"></div>');
  const win = dom.window as unknown as Window & typeof globalThis;
  const highlights = new Map<string, Set<Range>>();
  Object.defineProperty(win, "CSS", { value: { highlights }, configurable: true });
  Object.defineProperty(win, "Highlight", { value: class extends Set<Range> {}, configurable: true });
  const scrolls: ScrollToOptions[] = [];
  win.scrollTo = ((options: ScrollToOptions) => scrolls.push(options)) as typeof win.scrollTo;
  win.Range.prototype.getBoundingClientRect = () => ({ top: 900, height: 20 } as DOMRect);
  win.HTMLElement.prototype.scrollIntoView = () => {};
  return { dom, win, highlights, scrolls };
}

// The supported cmux script wraps text, assigns this array, then uses only
// isConnected, classList and scrollIntoView on search/next/previous.
function search(win: Window & typeof globalThis, query: string) {
  const host = win as typeof win & { __cmuxFindMatches: HTMLElement[]; __cmuxFindIndex: number };
  host.__cmuxFindMatches = [];
  const walker = win.document.createTreeWalker(win.document.body, win.NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const matches: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.textContent ?? "";
    if (!text.toLowerCase().includes(query.toLowerCase()) || !query) continue;
    const fragment = win.document.createDocumentFragment();
    let offset = 0;
    let index: number;
    while ((index = text.toLowerCase().indexOf(query.toLowerCase(), offset)) !== -1) {
      fragment.append(text.slice(offset, index));
      const mark = win.document.createElement("mark");
      mark.className = "__cmux-find";
      mark.textContent = text.slice(index, index + query.length);
      fragment.append(mark);
      matches.push(mark);
      offset = index + query.length;
    }
    fragment.append(text.slice(offset));
    node.parentNode!.replaceChild(fragment, node);
  }
  host.__cmuxFindMatches = matches;
  host.__cmuxFindIndex = 0;
  matches[0]?.classList.add("__cmux-find-current");
  matches[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  return (direction: number) => {
    const items = host.__cmuxFindMatches;
    let index = host.__cmuxFindIndex;
    if (!items[index]?.isConnected) return { total: 0, current: 0 };
    items[index]!.classList.remove("__cmux-find-current");
    index = (index + direction + items.length) % items.length;
    if (!items[index]?.isConnected) return { total: 0, current: 0 };
    items[index]!.classList.add("__cmux-find-current");
    items[index]!.scrollIntoView({ block: "center", behavior: "smooth" });
    host.__cmuxFindIndex = index;
    return { total: items.length, current: index };
  };
}

test("cmux search survives ProseMirror reconciliation without document or selection changes", async () => {
  const { dom, win, highlights, scrolls } = environment();
  const names = ["window", "document", "navigator", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, { value: name === "window" ? win : win[name], configurable: true, writable: true });
  const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", toDOM: () => ["p", 0] }, text: {} } });
  const state = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("Find this find and FIND.")), schema.node("paragraph", null, schema.text("Another find."))]) });
  let changed = false;
  const view = new EditorView(win.document.querySelector("#editor"), { state, dispatchTransaction(tr) { changed ||= tr.docChanged; view.updateState(view.state.apply(tr)); } });
  let cleanup = () => {};
  try {
    const brokenCycle = search(win, "find");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(brokenCycle(1)).toEqual({ total: 0, current: 0 });
    delete (win as any).__cmuxFindMatches;
    cleanup = installCmuxFindCompatibility(win);
    const cycle = search(win, "find");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelector("mark.__cmux-find")).toBeNull();
    expect(view.state.doc.eq(state.doc)).toBe(true);
    expect(view.state.selection.eq(state.selection)).toBe(true);
    expect(changed).toBe(false);
    expect([...highlights.get("tether-cmux-find")!].map((range) => range.toString())).toEqual(["Find", "find", "FIND", "find"]);
    expect(cycle(1)).toEqual({ total: 4, current: 1 });
    expect(cycle(-1)).toEqual({ total: 4, current: 0 });
    expect(cycle(-1)).toEqual({ total: 4, current: 3 });
    expect(cycle(1)).toEqual({ total: 4, current: 0 });
    expect(highlights.get("tether-cmux-find-current")?.size).toBe(1);
    expect(scrolls[0]).toEqual({ top: 910 - win.innerHeight / 2, behavior: "instant" });
    search(win, "another");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([...highlights.get("tether-cmux-find")!].map((range) => range.toString())).toEqual(["Another"]);
    search(win, "absent");
    expect(highlights.size).toBe(0);
    search(win, "find");
    (win as any).__cmuxFindMatches = []; // Escape/clear in cmux.
    expect(highlights.size).toBe(0);
    expect(changed).toBe(false);
  } finally {
    cleanup();
    view.destroy();
    dom.window.close();
    names.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test("cmux handles survive formatted text and CodeMirror node views in Milkdown", async () => {
  const { dom, win, highlights } = environment();
  const globals = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    SVGElement: win.SVGElement, ShadowRoot: win.ShadowRoot,
    customElements: win.customElements, DocumentFragment: win.DocumentFragment,
    MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.assign(globalThis, globals);
  const { Crepe } = await import("@milkdown/crepe");
  const crepe = new Crepe({ root: win.document.querySelector("#editor"), defaultValue: "A **needle** and a needle.\n\n```js\nconst needle = 'needle';\n```\n" });
  const cleanup = installCmuxFindCompatibility(win);
  try {
    await crepe.create();
    const before = crepe.getMarkdown();
    const cycle = search(win, "needle");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(crepe.getMarkdown()).toBe(before);
    expect([...highlights.get("tether-cmux-find")!].map((range) => range.toString())).toEqual(["needle", "needle", "needle", "needle"]);
    expect(cycle(1)).toEqual({ total: 4, current: 1 });
    expect(cycle(1)).toEqual({ total: 4, current: 2 });
    expect(cycle(1)).toEqual({ total: 4, current: 3 });
    expect(win.document.querySelector("mark.__cmux-find")).toBeNull();
  } finally {
    cleanup();
    await crepe.destroy();
    dom.window.close();
    previous.forEach(([name, descriptor]) => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test("other hosts are untouched and unsupported highlight APIs install no hook", () => {
  const { dom, win, highlights } = environment();
  const before = win.document.documentElement.outerHTML;
  const cleanup = installCmuxFindCompatibility(win);
  expect(win.document.documentElement.outerHTML).toBe(before);
  expect(highlights.size).toBe(0);
  cleanup();
  Object.defineProperty(win, "Highlight", { value: undefined });
  installCmuxFindCompatibility(win);
  expect(Object.getOwnPropertyDescriptor(win, "__cmuxFindMatches")).toBeUndefined();
  dom.window.close();
});

test.each([false, true])("centers zoomed matches with legacy WebKit coordinates: %s", (legacy) => {
  const { dom, win, scrolls, highlights } = environment();
  win.document.querySelector("#editor")!.innerHTML = '<div class="ProseMirror" style="zoom:1.5"><p>needle</p></div>';
  Object.defineProperty(win, "scrollY", { value: 200 });
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ width: legacy ? 100 : 200 } as DOMRect);
  win.Range.prototype.getBoundingClientRect = () => ({ top: legacy ? 800 : 1300, height: legacy ? 20 : 30 } as DOMRect);
  const cleanup = installCmuxFindCompatibility(win);
  try {
    const cycle = search(win, "needle");
    // The same document point (1515px) must be centered in both engines.
    expect(scrolls[0]).toEqual({ top: 1515 - win.innerHeight / 2, behavior: "instant" });
    win.document.querySelector("p")!.textContent = "Edited passage";
    expect(cycle(1)).toEqual({ total: 0, current: 0 });
    cleanup();
    expect(highlights.size).toBe(0);
  } finally { cleanup(); dom.window.close(); }
});
