import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { localPoint } from '@milkdown/kit/plugin/tooltip';
import { overlayPosition, placeOverlay } from '../src/web/overlay';
import { revealRect } from '../src/web/scroll-geometry';

const bounds = {left:100,right:500,top:50,bottom:400};
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
