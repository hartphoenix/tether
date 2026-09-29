export type FindSource = { key?: unknown; text: string; range(from: number, to: number): Range | null; reveal?(from: number): void };

/** Page-local Find; self-contained for the server-rendered Folio page. */
export function installPageFind(options: { roots: () => Element[]; sources?: () => FindSource[] }): () => void {
  const bar = document.createElement('section');
  bar.className = 'wm-find'; bar.hidden = true; bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', 'Find on page');
  bar.innerHTML = '<input type="search" aria-label="Find on page" placeholder="Find" autocomplete="off"><output aria-live="polite"></output><button type="button" aria-label="Previous match" title="Previous match">↑</button><button type="button" aria-label="Next match" title="Next match">↓</button><button type="button" aria-label="Close Find" title="Close Find">×</button>';
  const style = document.createElement('style');
  style.textContent = '.wm-find{position:fixed;z-index:100;right:12px;top:calc(44px * var(--wm-ui-scale,1));display:flex;align-items:center;gap:6px;padding:8px;max-width:calc(100vw - 24px);background:var(--wm-color-surface,var(--panel,#242424));color:var(--wm-color-on-surface,var(--text,#eee));border:1px solid var(--wm-color-outline,var(--line,#777));border-radius:8px;box-shadow:0 3px 12px #0003;font:calc(13px * var(--wm-ui-scale,1)) system-ui}.wm-find[hidden]{display:none}.wm-find input{min-width:0;width:12em;font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:4px}.wm-find button{font:inherit;color:inherit;background:transparent;border:0;padding:4px;cursor:pointer}.wm-find output{white-space:nowrap}::highlight(tether-find){background:#facc15;color:#000}::highlight(tether-find-current){background:#f97316;color:#000}';
  document.head.append(style); document.body.append(bar);
  const input = bar.querySelector('input')!, count = bar.querySelector('output')!, buttons = bar.querySelectorAll('button');
  let matches: { source: FindSource; from: number; to: number }[] = [];
  let index = -1, frame = 0, generation = 0;
  let priorFocus: HTMLElement | null = null;
  const domSources = (): FindSource[] => options.roots().flatMap(root => {
    // A paragraph/row is one search unit, so inline formatting does not split matches.
    const blocks = root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,td,th,.file');
    return [...(blocks.length ? blocks : [root])].filter(block => ![...block.children].some(child => child.matches('p,li,pre'))).flatMap(block => {
      if (!block.getClientRects().length || block.closest('[hidden],[inert]')) return [];
      const nodes: Text[] = []; const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        const excluded = text.parentElement?.closest('button,input,textarea,select,[hidden],[inert]');
        if ((!excluded || excluded === block) && text.parentElement?.getClientRects().length) nodes.push(text);
      }
      return [{ key: block, text: nodes.map(node => node.data).join(''), range(from: number, to: number) {
        const range = document.createRange(); let offset = 0, started = false;
        for (const node of nodes) {
          if (!node.isConnected) return null;
          if (!started && from < offset + node.length) { range.setStart(node, from - offset); started = true; }
          if (started && to <= offset + node.length) { range.setEnd(node, to - offset); return range; }
          offset += node.length;
        }
        return null;
      } }];
    });
  });
  const paint = () => {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const all = new Highlight(), current = new Highlight(); current.priority = 1;
    matches.forEach((match, i) => { const range = match.source.range(match.from, match.to); if (range) { all.add(range); if (i === index) current.add(range); } });
    CSS.highlights.set('tether-find', all); CSS.highlights.set('tether-find-current', current);
  };
  const reveal = () => {
    const match = matches[index]; if (!match) return;
    const token = ++generation;
    match.source.reveal?.(match.from);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== generation || bar.hidden) return;
      const range = match.source.range(match.from, match.to);
      if (range) {
        let box = range.getBoundingClientRect();
        let node = range.startContainer.parentElement;
        while (node) {
          const computed = getComputedStyle(node);
          if (/auto|scroll/.test(computed.overflowY) || /auto|scroll/.test(computed.overflowX)) {
            const rect = node.getBoundingClientRect();
            const header = node.parentElement?.querySelector(':scope > .milkdown-top-bar,:scope > .wm-annotation-rail-header,:scope > .top');
            const top = Math.max(rect.top, header?.getBoundingClientRect().bottom ?? rect.top, bar.getBoundingClientRect().bottom);
            const sx = rect.width / node.offsetWidth || 1, sy = rect.height / node.offsetHeight || 1;
            if (box.top < top || box.bottom > rect.bottom) node.scrollTop += (box.top - top - 12) / sy;
            if (box.left < rect.left || box.right > rect.right) node.scrollLeft += (box.left - rect.left - 12) / sx;
            box = range.getBoundingClientRect();
          }
          node = node.parentElement;
        }
      }
      paint();
    }));
  };
  const updateCount = () => { count.textContent = input.value ? (matches.length ? `${index + 1} / ${matches.length}` : 'No results') : ''; buttons[0]!.disabled = buttons[1]!.disabled = !matches.length; };
  const search = (navigate = true) => {
    const previous = matches[index]; matches = [];
    const query = input.value.toLowerCase();
    if (query) for (const source of [...(options.sources?.() ?? []), ...domSources()]) {
      const text = source.text.toLowerCase(); let from = 0;
      while ((from = text.indexOf(query, from)) >= 0) { matches.push({ source, from, to: from + query.length }); from += query.length; }
    }
    index = matches.length ? Math.max(0, matches.findIndex(m => previous && m.source.key === previous.source.key && m.from === previous.from)) : -1;
    updateCount(); paint(); if (navigate) reveal();
  };
  const move = (direction: number) => { if (!matches.length) return; index = (index + direction + matches.length) % matches.length; updateCount(); reveal(); };
  const close = () => { generation++; bar.hidden = true; matches = []; paint(); if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true }); };
  input.addEventListener('input', event => { if (!(event as InputEvent).isComposing) search(); });
  input.addEventListener('compositionend', () => search());
  buttons[0]!.onclick = () => move(-1); buttons[1]!.onclick = () => move(1); buttons[2]!.onclick = close;
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation();
      if (bar.hidden) { priorFocus = document.activeElement as HTMLElement; bar.hidden = false; search(false); }
      input.focus(); input.select();
    } else if (!bar.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (bar.contains(event.target as Node) && event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  };
  document.addEventListener('keydown', keydown, true);
  const observer = new MutationObserver(records => {
    if (bar.hidden || records.every(record => bar.contains(record.target))) return;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; search(false); });
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-expanded'] });
  return () => { generation++; observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown, true); matches = []; paint(); bar.remove(); style.remove(); };
}
