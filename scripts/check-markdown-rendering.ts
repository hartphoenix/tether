import { chromium, webkit } from "playwright";
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
const root = await mkdtemp('/tmp/tether-render-browser-');
const web = await createWebBundleResponder();
await mkdir(join(root,'docs'));
const source = '# Checks\n\nSelect these words.\n\nNote[^calibration].\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n\n```mermaid\nnot a diagram\n```\n\n[^calibration]: calibration belongs in this note.\n';

const daemon = createDaemon({config: resolveConfig({runtimeDir:join(root,'runtime'),configDir:join(root,'config')}),web});
try {
 await daemon.ready;
 for(const [name, engine] of [['chromium',chromium],['webkit',webkit]] as const) {
  const path=join(root,'docs',name+'.md');await writeFile(path,source);
  const browser=await engine.launch({headless:true});
  try {
   const page=await browser.newPage({viewport:{width:1100,height:900}});
   const grant=await daemon.service.open(path);


   page.on('requestfailed',request=>console.log('FAILED',request.url(),request.failure()));

   await page.goto(daemon.mintTicket(grant).url);
   await page.waitForSelector('.wm-mermaid svg');
   await page.waitForSelector('.wm-mermaid-error');
   const originalDiagram=await page.locator('.wm-mermaid svg').getAttribute('id');
   const nextTheme=await page.locator('html').getAttribute('data-wm-theme')==='tether-dark' ? 'tether' : 'tether-dark';
   await page.locator('#theme').click();
   await page.locator(`#theme-menu [data-theme="${nextTheme}"]`).click();
   await page.waitForFunction(id=>document.querySelector('.wm-mermaid svg')?.id!==id,originalDiagram);
   if(await readFile(path,'utf8')!==source)throw Error('Theme change rewrote the document');
   const clipped=await page.locator('.wm-mermaid svg').evaluate(svg=>{
     const bounds=svg.getBoundingClientRect();
     return [...svg.querySelectorAll('text')].some(text=>{const r=text.getBoundingClientRect();return r.top<bounds.top-1 || r.bottom>bounds.bottom+1 || r.left<bounds.left-1 || r.right>bounds.right+1;});
   });
   if(clipped)throw Error('Diagram label extends outside the SVG viewport');
   const fallback=page.locator('.milkdown-code-block').filter({has:page.locator('.wm-mermaid-error')});
   await fallback.getByRole('button',{name:'Edit',exact:true}).click();
   await fallback.locator('.cm-content').waitFor({state:'visible'});
   if(await page.locator('.wm-mermaid foreignObject').count())throw Error('Flowchart labels still use clipped HTML');
   const diagramBlock=page.locator('.milkdown-code-block').filter({has:page.locator('.wm-mermaid svg')});
   await diagramBlock.dispatchEvent('wheel',{deltaY:40});
   if(await page.getByRole('dialog',{name:'Diagram viewer'}).count())throw Error('Ordinary scrolling opened the viewer');
   await page.locator('.ProseMirror h1').dispatchEvent('wheel',{ctrlKey:true,deltaY:-40});
   if(await page.getByRole('dialog',{name:'Diagram viewer'}).count())throw Error('Pinching outside Mermaid opened the viewer');
   for(const gesture of ['wheel','gesturestart']) {
    await diagramBlock.dispatchEvent(gesture,{ctrlKey:true,deltaY:-40,cancelable:true});
    await page.getByRole('dialog',{name:'Diagram viewer'}).waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await page.getByRole('dialog',{name:'Diagram viewer'}).waitFor({state:'detached'});
   }
   await page.getByRole('button',{name:'Expand diagram',exact:true}).first().click();
   const viewer=page.getByRole('dialog',{name:'Diagram viewer'});
   await viewer.waitFor({state:'visible'});
   const controls=await viewer.locator('.wm-diagram-controls button').evaluateAll(buttons=>buttons.map(button=>({text:button.textContent, label:button.getAttribute('aria-label'), title:button.getAttribute('title'), icon:!!button.querySelector('svg.tether-icon')})));
   if(controls.length!==4 || controls.some(button=>button.text || !button.icon || !button.label || button.title!==button.label))throw Error('Viewer icon labels missing');
   const themed=await viewer.locator('.wm-diagram-stage > svg').evaluate(svg=>{
     const style=getComputedStyle(document.querySelector('.milkdown')!);
     const probe=document.createElement('span');
     probe.style.fontFamily=style.getPropertyValue('--wm-font-code') || style.getPropertyValue('--crepe-font-code');
     probe.style.color=style.getPropertyValue('--wm-color-surface') || style.getPropertyValue('--crepe-color-surface');
     document.body.append(probe);
     const expected=getComputedStyle(probe);
     const label=svg.querySelector('text')!, node=svg.querySelector('.node rect')!;
     const matches=getComputedStyle(label).fontFamily===expected.fontFamily && getComputedStyle(node).fill===expected.color;
     probe.remove();return matches;
   });
   if(!themed)throw Error('Mermaid did not use the theme surface and code font');
   const originalWidth=await viewer.locator('.wm-diagram-stage > svg').evaluate(svg=>svg.getBoundingClientRect().width);
   await viewer.locator('.wm-diagram-viewport').dispatchEvent('wheel',{ctrlKey:true,deltaY:-100,clientX:400,clientY:300});
   if(await viewer.locator('.wm-diagram-stage > svg').evaluate(svg=>svg.getBoundingClientRect().width)<=originalWidth)throw Error('Pinch zoom did not enlarge SVG');
   await viewer.locator('.wm-diagram-viewport').evaluate(element=>{element.scrollLeft=100;element.scrollTop=80;});
   if(await viewer.locator('.wm-diagram-viewport').evaluate(element=>element.scrollLeft)<=0)throw Error('Expanded viewer cannot pan');
   await viewer.locator('.wm-diagram-viewport').evaluate(element=>{
     element.dispatchEvent(new Event('gesturestart',{cancelable:true}));
     const event=new Event('gesturechange',{cancelable:true});Object.assign(event,{scale:1.25});element.dispatchEvent(event);
     element.dispatchEvent(new Event('gestureend',{cancelable:true}));
   });
   await page.setViewportSize({width:800,height:650});
   await viewer.getByRole('button',{name:'Fit',exact:true}).click();
   const bounds=await viewer.boundingBox();
   if(!bounds || Math.abs(bounds.width-800)>1 || Math.abs(bounds.height-650)>1)throw Error('Viewer did not follow viewport');
   await page.keyboard.press('Escape');
   await viewer.waitFor({state:'detached'});
   await page.waitForSelector('.wm-mermaid svg');
   await page.setViewportSize({width:1100,height:900});
   await page.locator('sup[data-type="footnote_reference"]').click();
   if(await page.locator('.wm-footnote-body').textContent()!=='calibration belongs in this note.')throw Error('footnote body');
   await page.keyboard.press('Escape');
   await page.evaluate(()=>{
    const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent==='Select these words.')!;
    const r=document.createRange();r.setStart(p.firstChild!,0);r.setEnd(p.firstChild!,6);
    const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(r);
    (p.closest('.ProseMirror') as HTMLElement).focus();document.dispatchEvent(new Event('selectionchange'));
   });
   const selected=page.locator('.ProseMirror p').filter({hasText:'Select these words.'});
   await selected.click({button:'right',position:{x:8,y:8}});
   const insertMenu=page.getByRole('menu',{name:'Insert',exact:true});
   const names=await insertMenu.locator('[role=menuitem] > span:last-child').allTextContents();
   const matchingColors=await insertMenu.evaluate(menu=>{
    const toolbar=document.querySelector('.milkdown-top-bar')!;
    const toolbarIcon=toolbar.querySelector('.top-bar-item svg')!;
    const label=menu.querySelector('[role="menuitem"] > span:last-child')!;
    const icon=menu.querySelector('svg')!;
    return getComputedStyle(menu).backgroundColor===getComputedStyle(toolbar).backgroundColor
      && getComputedStyle(label).color===getComputedStyle(toolbarIcon).color
      && getComputedStyle(icon).fill===getComputedStyle(toolbarIcon).fill;
   });
   if(!matchingColors)throw Error('Insert colors differ from the toolbar');
   for(const name of ['Footnote','Code block','Math block','Image','Table','Blockquote','Horizontal rule','Bulleted list','Numbered list','Task list'])if(!names.includes(name))throw Error('Missing Insert action: '+name+'; actual: '+names.join(', '));
   for(const name of ['Heading 1','Heading 2','Heading 3','Heading 4','Heading 5','Heading 6','Bold','Italic','Strikethrough','Inline code','Link','Comment'])if(names.includes(name))throw Error('Duplicate selection-toolbar action: '+name);
   if(await insertMenu.locator('.wm-insert-icon').count()!==names.length)throw Error('Insert action missing icon');
   const menuBounds=await insertMenu.boundingBox();
   if(!menuBounds || menuBounds.y<0 || menuBounds.y+menuBounds.height>900)throw Error('Insert menu outside viewport');
   if(await insertMenu.locator('.wm-insert-heading').count())throw Error('Insert menu retains a heading');
   const originalScale=await page.evaluate(()=>document.documentElement.style.getPropertyValue('--wm-ui-scale'));
   for(const scale of [0.75,1,1.5]) {
    await page.evaluate(scale=>document.documentElement.style.setProperty('--wm-ui-scale',String(scale)),scale);
    const metrics=await insertMenu.evaluate(menu=>({font:parseFloat(getComputedStyle(menu).fontSize),icon:menu.querySelector('svg')!.getBoundingClientRect().width}));
    if(Math.abs(metrics.font-13*scale)>.1 || Math.abs(metrics.icon-16*scale)>.1)throw Error('Insert menu does not follow interface scale: '+JSON.stringify(metrics));
   }
   await page.evaluate(value=>value ? document.documentElement.style.setProperty('--wm-ui-scale',value) : document.documentElement.style.removeProperty('--wm-ui-scale'),originalScale);
   await insertMenu.getByRole('menuitem',{name:'Footnote',exact:true}).click();
   if(await page.getByRole('textbox',{name:'Source label'}).count())throw Error('Custom-label UI remains');
   await page.getByRole('textbox',{name:'Footnote text',exact:true}).fill('A new explanatory note.');
   await page.getByRole('button',{name:'Insert footnote',exact:true}).click();
   await page.waitForSelector('sup[data-label^="note-"]');
   const label=await page.locator('sup[data-label^="note-"]').getAttribute('data-label');
   if(await page.locator('sup[data-label^="note-"]').textContent()!=='1')throw Error('New note not numbered first');
   if(await page.locator('sup[data-label="calibration"]').textContent()!=='2')throw Error('Existing note not renumbered');
   await page.waitForFunction(()=>!document.querySelector('.wm-footnote-composer'));
   await new Promise(r=>setTimeout(r,1200));
   const saved=await readFile(path,'utf8');
   if(!saved.includes(`Select[^${label}] these words.`))throw Error('Insertion removed selected passage');
   if(!saved.includes(`[^${label}]: A new explanatory note.`))throw Error('Saved footnote missing: '+saved);
   await page.reload();
   await page.locator('sup[data-label^="note-"]').click();
   if(await page.locator('.wm-footnote-body').textContent()!=='A new explanatory note.')throw Error('footnote reload');
   await page.keyboard.press('Escape');
   // Synthetic clipboard events use the editor's real cut/paste handlers without touching the OS clipboard.
   await page.evaluate(()=>{
    const editor=document.querySelector<HTMLElement>('.ProseMirror')!;editor.focus();
    const range=document.createRange();range.selectNode(editor.querySelector('dl[data-label^="note-"]')!);
    const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
   });
   await page.waitForTimeout(100);
   const copiedWholeDefinition=await page.evaluate(()=>{
    const editor=document.querySelector<HTMLElement>('.ProseMirror')!;
    const clipboard=new DataTransfer();
    editor.dispatchEvent(new ClipboardEvent('cut',{clipboardData:clipboard,bubbles:true,cancelable:true}));
    if(!clipboard.getData('text/html'))throw Error('No clipboard HTML');
    (window as any).footnoteClipboard=clipboard;
    return clipboard.getData('text/html').includes('data-type="footnote_definition"');
   });
   await page.keyboard.press('Meta+ArrowUp');
   await page.evaluate(()=>document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste',{clipboardData:(window as any).footnoteClipboard,bubbles:true,cancelable:true})));
   await page.locator('sup[data-label^="note-"]').click();
   if(copiedWholeDefinition && await page.locator('.wm-footnote-body').textContent()!=='A new explanatory note.')throw Error('Whole-definition clipboard move lost linkage');
   await page.keyboard.press('Escape');
   await page.locator('.ProseMirror h1').filter({hasText:'Checks'}).click({button:'right'});
   await page.getByRole('menu',{name:'Insert',exact:true}).getByRole('menuitem',{name:'Code block',exact:true}).click();
   await page.locator('.milkdown-code-block .cm-content').filter({hasText:'Checks'}).waitFor({state:'visible'});
   console.log(name+': Mermaid labels, expanded viewer, wheel/gesture zoom, pan, resize and close; footnote insertion, stable label and reload passed; clipboard selection: '+(copiedWholeDefinition?'whole definition, linkage retained':'body only, cannot move definition reliably'));
  } finally {await browser.close();}
 }
} finally {await daemon.stop(); await rm(root,{recursive:true,force:true});}
