import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
const html=await Bun.file('./src/web/index.html').text();
const dom=new JSDOM(html,{url:'http://localhost/s/test/',pretendToBeVisual:true,runScripts:'outside-only'});
const w=dom.window;
for(const key of ['window','document','navigator','Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLDivElement','HTMLButtonElement','DocumentFragment','MutationObserver','DOMParser','getComputedStyle','Event','KeyboardEvent','MouseEvent','Range','ShadowRoot','SVGElement','location','history']) (globalThis as any)[key]=key==='window'?w:(w as any)[key];
for(const key of ['requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener']) (globalThis as any)[key]=(w as any)[key].bind(w);
(globalThis as any).ResizeObserver=class{observe(){} unobserve(){} disconnect(){}};
(globalThis as any).IntersectionObserver=class{observe(){} unobserve(){} disconnect(){}};
(w as any).matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
Object.defineProperty(w.document,'fonts',{value:{ready:Promise.resolve(),addEventListener(){},removeEventListener(){}}});
(w.navigator as any).sendBeacon=()=>true;
Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);
Range.prototype.getClientRects=()=>[] as any;
let doc={path:'/remote/shared.md',body:'# Shared document\n\nOriginal text.\n',bodyRevision:'sha256:base',ledgerRevision:'empty',locationVersion:1,annotations:{threads:[]}};
let preferences={theme:'tether',customThemes:[],uiScale:1,commentTextSize:16};
let attempts=0, writes=0, verifies=0, drop:'before'|'after'|'gateway'|null=null, unavailable=false;
(globalThis as any).fetch=async(url:string,options:any={})=>{
 const path=new URL(url,w.location.href).pathname;
 if(path.endsWith('/history'))return Response.json(new URL(url,w.location.href).searchParams.has('threadId')?{messages:[{actor:'assistant',createdAt:'earlier',body:'Historical response.'}],continuation:null}:{threads:[{id:'thread-one',actor:'human',excerpt:'Offline question.',status:'open'}],continuation:null,bodyRevision:null,anchorContext:'unavailable'});
 if(unavailable&&['/file','/changes','/bootstrap','/verify-save'].some(suffix=>path.endsWith(suffix)))return Response.json({error:{code:'connector_disconnected',message:'File connector disconnected.'}},{status:503});
 if(path.endsWith('/bootstrap'))return Response.json({document:doc,preferences,capabilities:{},sharedReader:true,scroll:0,zoom:100});
 if(path.endsWith('/preferences'))return Response.json(preferences);
 if(path.endsWith('/changes'))return Response.json({path:doc.path,bodyRevision:doc.bodyRevision,ledgerRevision:doc.ledgerRevision});
 if(path.endsWith('/verify-save')){verifies++;const value=JSON.parse(options.body);return Response.json({outcome:doc.body===value.body?'matches_edit':doc.bodyRevision===value.expectedBodyRevision?'matches_base':'diverged',document:doc});}
 if(path.endsWith('/file')){if(options.method==='PUT'){
   const request=JSON.parse(options.body);attempts++;
   if(request.expectedLocationVersion!==doc.locationVersion||options.headers['x-tether-location-version']!==String(doc.locationVersion))throw new Error('Reader omitted location fence: '+JSON.stringify({request,headers:options.headers}));
   if(drop==='before'){drop=null;throw new TypeError('Response lost before write');}
   if(request.expectedBodyRevision!==doc.bodyRevision)return Response.json({error:{code:'conflict',message:'Conflict',details:{outcome:'not_applied'}}},{status:409});
   writes++;doc={...doc,body:request.content,bodyRevision:'sha256:'+writes};
   if(drop==='gateway'){drop=null;return Response.json({error:{code:'upstream_error',message:'Upstream response lost'}},{status:502});}
   if(drop==='after'){drop=null;throw new TypeError('Response lost after write');}
 }return Response.json(doc);}
 if(path.endsWith('/annotations'))return Response.json({...doc,annotations:{threads:[]}});
 if(path.endsWith('/draft'))throw new Error('Shared draft must remain in the active editor');
 return Response.json({});
};
const build=await Bun.build({entrypoints:['./src/web/app.ts'],target:'browser',format:'iife'});
if(!build.success)throw new Error(String(build.logs));
(w as any).fetch=globalThis.fetch;
(w as any).structuredClone=structuredClone;
(w as any).TextEncoder=TextEncoder;
(w as any).TextDecoder=TextDecoder;
(w as any).ResizeObserver=(globalThis as any).ResizeObserver;
(w as any).IntersectionObserver=(globalThis as any).IntersectionObserver;
w.eval(await build.outputs.find(x=>x.path.endsWith('.js'))!.text());
const wait=async(check:()=>boolean)=>{const caller=new Error().stack;for(let i=0;i<500;i++){if(check())return;await Bun.sleep(20);}throw new Error('Timed out: '+document.querySelector('#notice')?.textContent+' '+JSON.stringify({attempts,writes,verifies})+'\n'+caller);};
await wait(()=>!!document.querySelector('.ProseMirror')&&!(document.querySelector('#editor') as HTMLElement)?.inert);
// A lost response after commit verifies the actual bytes without replaying a write.
(document.querySelector('#source') as HTMLButtonElement).click();
await wait(()=>!!document.querySelector('.wm-source-editor'));
let input=EditorView.findFromDOM(document.querySelector('.wm-source-editor')!)!;
drop='gateway';input.dispatch({changes:{from:input.state.doc.length,insert:'First draft.\n'}});
await wait(()=>attempts===1);
await wait(()=>document.querySelector('#notice')!.textContent!.includes('Save not yet confirmed'));
w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>verifies>0&&document.querySelector('#notice')!.textContent!.includes('matches your edit'));
if(attempts!==1||writes!==1||!input.state.sliceDoc().includes('First draft.'))throw new Error('Unknown save was replayed or its draft lost');
// A lost response before commit offers an explicit retry retaining the original base.
drop='before';input.dispatch({changes:{from:input.state.doc.length,insert:'Second draft.\n'}});
await wait(()=>Number(attempts)===2);w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>!!document.querySelector('#save-confirmation button'));
await Bun.sleep(800);
if(Number(attempts)!==2||Number(writes)!==1)throw new Error('An unconfirmed save was retried automatically');
(document.querySelector('#save-confirmation button') as HTMLButtonElement).click();
await wait(()=>Number(writes)===2);
await Bun.sleep(0); // Let the explicit save response finish before switching views.
if(!doc.body.includes('Second draft.'))throw new Error('Explicit retry lost the active draft');
// Accept All uses the same unknown-write recovery contract.
(document.querySelector('#source') as HTMLButtonElement).click();
await wait(()=>!document.querySelector('.wm-source-editor'));
doc={...doc,body:'## External revision\n\nUpdated remotely.\n',bodyRevision:'sha256:external'};
w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>!document.querySelector<HTMLButtonElement>('#save-review')!.hidden);
drop='after';const prior=verifies;
(document.querySelector('#save-review') as HTMLButtonElement).click();
await wait(()=>document.querySelector('#notice')!.textContent!.includes('Save not yet confirmed'));
w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>verifies>prior&&document.querySelector('#notice')!.textContent!.includes('matches your edit'));
if(Number(attempts)!==4||Number(writes)!==3)throw new Error('Reviewed save was replayed');
// Unavailable file context never masquerades as a current body; central threads still load.
unavailable=true;w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>!!document.querySelector('#historical-reviews'));
if(!(document.querySelector('#editor') as HTMLElement).hidden)throw new Error('Unavailable clean body was still displayed');
const detail=document.querySelector<HTMLDetailsElement>('#historical-reviews details')!;detail.open=true;
await wait(()=>detail.textContent!.includes('Historical response.'));
unavailable=false;w.dispatchEvent(new w.Event('pageshow'));
await wait(()=>!document.querySelector('#historical-reviews')&&!(document.querySelector('#editor') as HTMLElement).hidden);
console.log('Shared reader workflows passed: lost-response verification, explicit retry, reviewed saves, location fences and body-free history.');
w.dispatchEvent(new w.Event('pagehide'));dom.window.close();
