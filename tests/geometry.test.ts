import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { localPoint } from '@milkdown/kit/plugin/tooltip';
import { overlayPosition, placeOverlay } from '../src/web/overlay';
import { keepContentEndVisible, revealRect } from '../src/web/scroll-geometry';

const bounds = {left:100,right:500,top:50,bottom:400};

test('empty document and drawer recover independently, ignoring padding and hidden trailing nodes', async () => {
  const dom = new JSDOM('<div class="milkdown"><header class="milkdown-top-bar"></header><article><p>End</p><p hidden>Hidden Markdown</p></article></div><div><aside><section><p>Last thread</p></section></aside></div>');
  const win = dom.window;
  const document = win.document;
  const article = document.querySelector('article')!;
  const rail = document.querySelector('aside')!;
  const content = document.querySelector('section')!;
  let pageScroll = 2000;
  rail.scrollTop = 2000;
  let documentEnd = 1900, threadEnd = 1900;
  let hidden = false;
  const resizeCallbacks = new Set<() => void>();
  win.ResizeObserver = class {
    constructor(readonly callback: () => void) { resizeCallbacks.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  } as unknown as typeof ResizeObserver;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  win.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  const tick = async () => {
    await Promise.resolve(); // Deliver mutation observers before the animation frame.
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  };
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top } as DOMRect);
  Object.defineProperty(win, 'innerHeight', { value: 800 });
  Object.defineProperties(rail, { offsetHeight: { value: 800 }, clientHeight: { value: 800 } });
  rail.getBoundingClientRect = () => rect(0, 800);
  article.getClientRects = () => [rect(0, 4000)] as unknown as DOMRectList;
  content.getClientRects = () => (hidden ? [] : [rect(0, 4000)]) as unknown as DOMRectList;
  document.querySelector('header')!.getBoundingClientRect = () => rect(0, 44);
  article.firstElementChild!.getBoundingClientRect = () => rect(documentEnd - pageScroll - 20, documentEnd - pageScroll);
  content.firstElementChild!.getBoundingClientRect = () => rect(threadEnd - rail.scrollTop - 20, threadEnd - rail.scrollTop);
  win.scrollBy = ((options: ScrollToOptions) => { pageScroll += options.top ?? 0; }) as typeof win.scrollBy;
  const stopDocument = keepContentEndVisible(article);
  const stopRail = keepContentEndVisible(content, rail);
  await tick();
  expect(documentEnd - pageScroll).toBeCloseTo(44 + 756 * .8);
  expect(threadEnd - rail.scrollTop).toBeCloseTo(640);

  // A shrink within the same padded/min-height container must still be detected.
  const stablePage = pageScroll;
  threadEnd = rail.scrollTop - 50;
  content.firstElementChild!.textContent = 'Shortened comment';
  await tick();
  expect(threadEnd - rail.scrollTop).toBeCloseTo(640);
  expect(pageScroll).toBe(stablePage);

  // Font/image/width reflow can shrink content without changing the DOM.
  threadEnd = rail.scrollTop - 50;
  for (const callback of resizeCallbacks) callback();
  await tick();
  expect(threadEnd - rail.scrollTop).toBeCloseTo(640);
  expect(pageScroll).toBe(stablePage);

  const stableRail = rail.scrollTop;
  documentEnd = pageScroll - 50;
  article.firstElementChild!.textContent = 'Shortened document';
  await tick();
  expect(documentEnd - pageScroll).toBeCloseTo(648.8);
  expect(rail.scrollTop).toBe(stableRail);

  // Leave even partially visible content, and hidden drawers, alone.
  documentEnd = pageScroll + 45;
  article.firstElementChild!.textContent = 'Still visible';
  hidden = true;
  threadEnd = rail.scrollTop - 100;
  rail.dispatchEvent(new win.Event('scroll'));
  const visiblePage = pageScroll;
  await tick();
  expect(pageScroll).toBe(visiblePage);
  expect(rail.scrollTop).toBe(stableRail);

  // Content hidden behind the sticky drawer header also needs recovery.
  hidden = false;
  const header = document.createElement('header');
  header.className = 'wm-annotation-rail-header';
  header.getBoundingClientRect = () => rect(0, 80);
  rail.parentElement!.prepend(header);
  threadEnd = rail.scrollTop + 60;
  rail.dispatchEvent(new win.Event('scroll'));
  await tick();
  expect(threadEnd - rail.scrollTop).toBeCloseTo(80 + 720 * .8);
  expect(pageScroll).toBe(visiblePage);

  // Disposal cancels pending work and detaches listeners/observers.
  win.dispatchEvent(new win.Event('resize'));
  stopDocument(); stopRail();
  expect(frames.size).toBe(0);
  expect(resizeCallbacks.size).toBe(0);
  article.firstElementChild!.remove();
  rail.dispatchEvent(new win.Event('scroll'));
  await tick();
  expect(frames.size).toBe(0);
  dom.window.close();
});
test('overlay flips and clamps inside an offset canvas', () => {
  expect(overlayPosition({left:480,right:490,top:350,bottom:370}, 150, 100, bounds)).toEqual({left:350,top:242});
  expect(overlayPosition(null, 700, 500, bounds)).toEqual({left:100,top:50});
});

test('viewport pointer converts once through scale, border and local scroll', () => {
  const dom = new JSDOM('<div></div>');
  const node = dom.window.document.querySelector('div')!;
  Object.defineProperties(node, {offsetWidth:{value:200},offsetHeight:{value:100},clientLeft:{value:2},clientTop:{value:3}});
  node.getBoundingClientRect = () => ({left:100,top:80,width:250,height:125} as DOMRect);
  node.scrollLeft=40;node.scrollTop=20;
  expect(localPoint(node, 225, 142.5)).toEqual({x:138,y:67});
});

test('nested scroll consumes viewport distance before window scroll', () => {
  const dom = new JSDOM('<div style="overflow-x:auto"><span></span></div>');
  const win=dom.window, node=win.document.querySelector('div')!;
  const previous=globalThis.HTMLElement; globalThis.HTMLElement=win.HTMLElement as any;
  try {
    Object.defineProperties(node,{offsetWidth:{value:200},offsetHeight:{value:100},clientWidth:{value:200},clientHeight:{value:100},scrollWidth:{value:500}});
    node.getBoundingClientRect=()=>({left:100,top:100,width:250,height:125} as DOMRect);
    let delta: number[]=[]; win.scrollBy=((x:number,y:number)=>{delta=[x,y]}) as any;
    revealRect({left:450,right:452,top:150,bottom:170}, node.firstElementChild!, 0);
    expect(node.scrollLeft).toBeCloseTo(81.6);
    expect(delta).toEqual([0,0]);
  } finally {globalThis.HTMLElement=previous;dom.window.close();}
});

test('caret reveal scrolls the document below its header without moving the root', () => {
  const dom = new JSDOM('<header class="milkdown-top-bar"></header><div class="wm-document-scroll" style="overflow-y:auto"><p>Text</p></div>');
  const win = dom.window, node = win.document.querySelector('div')!;
  const previous = globalThis.HTMLElement;
  globalThis.HTMLElement = win.HTMLElement as any;
  try {
    Object.defineProperties(node, {
      offsetWidth: { value: 800 }, offsetHeight: { value: 800 },
      clientWidth: { value: 800 }, clientHeight: { value: 800 }, scrollHeight: { value: 3000 },
    });
    node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 } as DOMRect);
    win.document.querySelector('header')!.getBoundingClientRect = () => ({ top: 0, bottom: 44, height: 44 } as DOMRect);
    let rootScrolled = false;
    win.scrollBy = (() => { rootScrolled = true; }) as any;
    revealRect({ left: 100, right: 102, top: 900, bottom: 920 }, node.firstElementChild!);
    expect(node.scrollTop).toBe(128);
    revealRect({ left: 100, right: 102, top: 30, bottom: 50 }, node.firstElementChild!);
    expect(node.scrollTop).toBe(106);
    expect(rootScrolled).toBe(false);
  } finally { globalThis.HTMLElement = previous; dom.window.close(); }
});

test('overlay source loss, pinning, dismissal and disposal share one lifecycle', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const win=dom.window;let callbacks: FrameRequestCallback[]=[];
  win.requestAnimationFrame=(callback)=>{callbacks.push(callback);return callbacks.length};
  const tick=()=>{const current=callbacks;callbacks=[];for(const callback of current)callback(0)};
  const root=win.document.querySelector<HTMLElement>('#root')!;
  let source: typeof bounds | null={left:50,right:60,top:100,bottom:120};
  const node=win.document.createElement('textarea');node.value='draft';root.append(node);
  const stop=placeOverlay(node,{root,reference:()=>source,policy:'pin'});
  source=null;tick();expect(node.isConnected).toBe(true);expect(node.value).toBe('draft');
  stop();const top=node.style.top;source=bounds;tick();expect(node.style.top).toBe(top);
  const floating=win.document.createElement('div');root.append(floating);
  placeOverlay(floating,{root,reference:()=>source,policy:'follow'});source=null;tick();expect(floating.isConnected).toBe(false);
  const menu=win.document.createElement('div');root.append(menu);
  placeOverlay(menu,{root,reference:()=>bounds,policy:'dismiss'});win.dispatchEvent(new win.Event('scroll'));expect(menu.isConnected).toBe(false);
  tick();tick();expect(callbacks).toHaveLength(0);win.close();
});
