/**
 * Compatibility with cmux 0.64.22 (ddd4a01bc), BrowserFindScript.swift.
 * Its native find bar injects marks, then stores them in __cmuxFindMatches.
 * ProseMirror/CodeMirror remove those foreign nodes, invalidating navigation.
 * Convert that assignment synchronously into range-backed handles, before the
 * editors' mutation observers run. CSS highlights never enter the editor model.
 * Remove this adapter when the supported cmux build uses non-mutating find.
 */
type Match = {
  readonly isConnected: boolean;
  classList: { add(name: string): void; remove(name: string): void };
  scrollIntoView(options?: ScrollIntoViewOptions): void;
};
type FindWindow = Window & typeof globalThis & { __cmuxFindMatches?: Match[] };

export function installCmuxFindCompatibility(win: Window & typeof globalThis): () => void {
  // In other hosts the cmux assignment never occurs. No shortcut interception.
  if (!win.CSS?.highlights || !win.Highlight) return () => {};
  const host = win as FindWindow;
  const key = "__cmuxFindMatches";
  if (Object.getOwnPropertyDescriptor(host, key)) return () => {};
  const doc = win.document;
  const allName = "tether-cmux-find";
  const currentName = "tether-cmux-find-current";
  let matches: Match[] = [];
  let anchors: Array<{ parent: Node; text: string; start: number; end: number; current: boolean }> = [];
  let unscaledZoomRects: boolean | undefined;
  const style = doc.createElement("style");
  style.textContent = `::highlight(${allName}) { background: #facc15; color: #000; }
    ::highlight(${currentName}) { background: #f97316; color: #fff; }`;

  function rangeFor(anchor: typeof anchors[number]): Range | null {
    if (!anchor.parent.isConnected || anchor.parent.textContent !== anchor.text) return null;
    const walker = doc.createTreeWalker(anchor.parent, win.NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const end = offset + (node.textContent?.length ?? 0);
      if (!started && anchor.start < end) {
        range.setStart(node, anchor.start - offset);
        started = true;
      }
      if (started && anchor.end <= end) {
        range.setEnd(node, anchor.end - offset);
        return range;
      }
      offset = end;
    }
    return null;
  }

  function paint(): void {
    win.CSS.highlights.delete(allName);
    win.CSS.highlights.delete(currentName);
    if (!anchors.length) { style.remove(); return; }
    if (!style.isConnected) doc.head.append(style);
    const all = new win.Highlight();
    const current = new win.Highlight();
    current.priority = 1;
    for (const anchor of anchors) {
      const range = rangeFor(anchor);
      if (range) { all.add(range); if (anchor.current) current.add(range); }
    }
    win.CSS.highlights.set(allName, all);
    win.CSS.highlights.set(currentName, current);
  }

  // Rebind ranges after the editor reconciles split/normalized text nodes.
  const observer = new win.MutationObserver(paint);
  Object.defineProperty(host, key, {
    configurable: true,
    get: () => matches,
    set: (incoming: Match[]) => {
      observer.disconnect();
      anchors = [];
      matches = incoming;
      const marks = incoming.filter((node): node is HTMLElement => node instanceof win.HTMLElement && node.matches("mark.__cmux-find"));
      for (const mark of marks) {
        // Textblock DOM can be replaced during reconciliation; the editor root
        // survives it. Keep offsets in that stable root, not in the old <p>.
        const parent = mark.closest(".ProseMirror, .cm-content") ?? mark.parentNode;
        if (!parent) continue;
        const prefix = doc.createRange();
        prefix.setStart(parent, 0);
        prefix.setEndBefore(mark);
        const start = prefix.toString().length;
        anchors.push({ parent, text: parent.textContent ?? "", start, end: start + (mark.textContent?.length ?? 0), current: false });
      }
      // Keep text nodes until every wrapper is gone, then normalize once per
      // parent. No foreign mark or find formatting reaches Markdown serialization.
      const parents = new Set(marks.map((mark) => mark.parentNode));
      for (const mark of marks) mark.replaceWith(...mark.childNodes);
      for (const parent of parents) parent?.normalize();
      const handles: Match[] = anchors.map((anchor) => ({
        get isConnected() { return rangeFor(anchor) !== null; },
        classList: {
          add(name) { if (name === "__cmux-find-current") { anchor.current = true; paint(); } },
          remove(name) { if (name === "__cmux-find-current") { anchor.current = false; paint(); } },
        },
        scrollIntoView() {
          const range = rangeFor(anchor);
          if (!range) return;
          const rect = range.getBoundingClientRect();
          if (unscaledZoomRects === undefined) {
            const probe = doc.createElement("div");
            probe.style.cssText = "position:absolute;left:-10000px;top:0;width:100px;height:1px;zoom:2;visibility:hidden";
            doc.body.append(probe);
            unscaledZoomRects = Math.abs(probe.getBoundingClientRect().width - 100) < 1;
            probe.remove();
          }
          let zoom = 1;
          if (unscaledZoomRects) {
            for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
              zoom *= Number.parseFloat(win.getComputedStyle(el).zoom) || 1;
            }
          }
          // Use the final text geometry, not a wrapper the editor will remove.
          // Older WebKit reports document coordinates before CSS zoom, then
          // subtracts the (scaled) window scroll offset. Correct both terms.
          const center = (rect.top + win.scrollY + rect.height / 2) * zoom;
          win.scrollTo({ top: center - win.innerHeight / 2, behavior: "instant" });
        },
      }));
      // cmux still uses its local array to select/scroll the initial result.
      incoming.splice(0, incoming.length, ...handles);
      paint();
      if (anchors.length) observer.observe(doc.body, { childList: true, characterData: true, subtree: true });
    },
  });
  return () => {
    observer.disconnect();
    anchors = [];
    paint();
    delete host[key];
  };
}
