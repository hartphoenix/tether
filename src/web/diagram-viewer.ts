import { regionLayer, visualMatches } from './visual-regions';
import { editorVisualBlocks, locateEditorVisual } from "./visual-blocks";
import { installVisualSelection, type VisualSelectionOptions } from "./visual-selection";
import { captureRange, type AnnotationThread, type AnnotationUiController } from "./annotations-ui";
import { type AnnotationAnchor } from "../core/annotation-ledger";
import type { EditorView } from "@milkdown/kit/prose/view";
let annotationBridge: { createDrawer: (root: HTMLElement, onOpenChange: (open: boolean) => void) => AnnotationUiController; selectThread: (thread: AnnotationThread) => void; prepare: (anchor: AnnotationAnchor, doc: unknown) => Promise<AnnotationAnchor>; save: (anchor: AnnotationAnchor, png: string, body: string, operationId: string, thread?: AnnotationThread) => Promise<void> } | undefined;
let viewerView: EditorView | undefined;
let activeViewer: (() => void) | undefined;
let visualThreads: readonly AnnotationThread[] = [];
export function configureVisualAnnotations(bridge: typeof annotationBridge) { annotationBridge = bridge; }
export function setVisualThreads(threads: readonly AnnotationThread[]) { visualThreads=threads; document.dispatchEvent(new Event('wm-visual-threads')); }
function visualSource(view: EditorView, anchor: AnnotationAnchor): SVGSVGElement | HTMLImageElement | null {
 const block=locateEditorVisual(view.state.doc,anchor);if(!block)return null;
 const dom=view.nodeDOM(block.position);if(!(dom instanceof HTMLElement))return null;
 return block.kind==='mermaid'?dom.querySelector('.wm-mermaid svg'):dom instanceof HTMLImageElement?dom:dom.querySelector('img');
}

function selectionOptions(source: SVGSVGElement | HTMLImageElement, view:EditorView, thread?:AnnotationThread, redraw=false):VisualSelectionOptions|undefined {
 const bridge=annotationBridge;if(!bridge)return;
 let anchor:AnnotationAnchor|null=null;
 view.state.doc.descendants((node,pos)=>{
  if(anchor)return false;
  const dom=view.nodeDOM(pos);if(!(dom instanceof HTMLElement)||!(dom===source||dom.contains(source)))return;
  if(source instanceof SVGSVGElement && node.type.name!=='code_block')return;
  if(source instanceof HTMLImageElement && !node.type.name.includes('image'))return;
  anchor=captureRange(view.state.doc,pos+(source instanceof SVGSVGElement?1:0),pos+node.nodeSize-(source instanceof SVGSVGElement?1:0),'sha256:'+'0'.repeat(64));
  if(anchor)anchor.visual={version:1,kind:source instanceof SVGSVGElement?'mermaid':'image',source:source instanceof SVGSVGElement?node.textContent:String(node.attrs.src??''),occurrences:editorVisualBlocks(view.state.doc).blocks.filter(b=>b.kind===(source instanceof SVGSVGElement?"mermaid":"image")&&b.source===(source instanceof SVGSVGElement?node.textContent:String(node.attrs.src??""))).length,layoutRevision:'',evidence:'',width:1,height:1,region:{x:0,y:0,width:1,height:1}};
 });
 if(!anchor)return;
 const selected=anchor as AnnotationAnchor,doc=view.state.doc,owner=source.parentElement!,imageUrl=source instanceof HTMLImageElement?source.currentSrc:null;
 return {createDrawer:bridge.createDrawer,threads:()=>visualThreads.filter(t=>t.anchor.visual && locateEditorVisual(view.state.doc,t.anchor)?.position===locateEditorVisual(view.state.doc,selected)?.position),isThreadVisible:()=>!thread || visualThreads.some(t=>t.id===thread.id),currentSource:selected.visual!.source, regions:()=>visualThreads.filter(t=>visualSource(view,t.anchor)===source || (t.anchor.visual && locateEditorVisual(view.state.doc,t.anchor)?.position===locateEditorVisual(view.state.doc,selected)?.position)).map(t=>({threadId:t.id,anchor:t.anchor,label:String(1 + (t.replies?.length ?? 0)),open:()=>bridge.selectThread(t)})),isCurrent:()=>owner.isConnected&&view.state.doc===doc&&(source instanceof HTMLImageElement?source.currentSrc===imageUrl:!owner.querySelector("svg")||owner.querySelector("svg")===source),prepare:()=>bridge.prepare(selected,doc),save:(a,p,b,id)=>bridge.save(a,p,b,id,thread),thread,redraw};
}
export function revealVisualThread(thread:AnnotationThread,redraw=false):boolean {
 if(!viewerView||!thread.anchor.visual)return false;
 const existing=document.querySelector<HTMLDialogElement>("dialog.wm-diagram-viewer");
 if(existing?.dataset.threadId===thread.id){existing.dispatchEvent(new Event("wm-show-thread"));if(redraw)existing.dispatchEvent(new Event("wm-redraw"));return true;}
 if(existing)activeViewer?.();
 const source=visualSource(viewerView,thread.anchor);if(!source)return false;
 openDiagramViewer(source,viewerView.dom,selectionOptions(source,viewerView,thread,redraw));return true;
}
import { iconSvg } from "./icons";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

const expandIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m0-6 7 7m5-7h6v6m0-6-7 7M3 15v6h6m-6 0 7-7m11 1v6h-6m6 0-7-7" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';

const documentImage = "img.image-inline, .milkdown-image-block .image-wrapper > img";

/** Diagrams move into the viewer to keep their SVG IDs unique; images are copied. */
export function openDiagramViewer(source: SVGSVGElement | HTMLImageElement, trigger: HTMLElement, selection?: VisualSelectionOptions): () => void {
  activeViewer?.();
  const image = source instanceof HTMLImageElement;
  const svg = image ? source.cloneNode() as HTMLImageElement : source;
  if (image) svg.removeAttribute("style");
  const parent = source.parentElement!;
  const originalStyle = svg.getAttribute("style");
  const dialog = document.createElement("dialog");
  dialog.className = "wm-diagram-viewer";
  if(selection?.thread)dialog.dataset.threadId=selection.thread.id;
  dialog.setAttribute("aria-label", image ? "Image viewer" : "Diagram viewer");
  const controls = document.createElement("div");
  controls.className = "wm-diagram-controls";
  const viewport = document.createElement("div");
  viewport.className = "wm-diagram-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", `${image ? "Image" : "Diagram"}; pinch to zoom, scroll to pan`);
  const stage = document.createElement("div");
  stage.className = "wm-diagram-stage";
  const output = document.createElement("output");
  output.setAttribute("aria-label", image ? "Image zoom" : "Diagram zoom");
  const box = image ? { width: source.naturalWidth, height: source.naturalHeight } : source.viewBox.baseVal;
  const width = box.width || source.getBoundingClientRect().width || 1;
  const height = box.height || source.getBoundingClientRect().height || 1;
  let zoom = 1, fit = 1, closed = false;
  function layout() {
    const w = width * fit * zoom, h = height * fit * zoom;
    stage.style.width = `${Math.max(viewport.clientWidth, w + 32)}px`;
    stage.style.height = `${Math.max(viewport.clientHeight, h + 32)}px`;
    svg.style.setProperty("width", `${w}px`, "important");
    svg.style.setProperty("height", `${h}px`, "important");
    svg.style.setProperty("max-width", "none", "important");
    output.textContent = `${Math.round(zoom * 100)}%`;
  }
  function setZoom(value: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    const oldWidth = width * fit * zoom, oldHeight = height * fit * zoom;
    const px = (viewport.scrollLeft + x - (stage.clientWidth - oldWidth) / 2) / oldWidth;
    const py = (viewport.scrollTop + y - (stage.clientHeight - oldHeight) / 2) / oldHeight;
    dialog.dispatchEvent(new Event("wm-visual-transform"));
    zoom = Math.max(.2, Math.min(8, value));
    layout();
    viewport.scrollLeft = px * width * fit * zoom + (stage.clientWidth - width * fit * zoom) / 2 - x;
    viewport.scrollTop = py * height * fit * zoom + (stage.clientHeight - height * fit * zoom) / 2 - y;
  }
  function button(label: string, icon: Parameters<typeof iconSvg>[0], action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-comment-button";
    button.innerHTML = iconSvg(icon);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", action);
    controls.append(button);
    return button;
  }
  button("Zoom out", "zoom-out", () => setZoom(zoom / 1.25));
  controls.append(output);
  button("Zoom in", "zoom-in", () => setZoom(zoom * 1.25));
  button("Fit", "minimize", () => { zoom = 1; resize(); });
  const close = button("Close", "x", () => dialog.close());
  stage.append(svg); viewport.append(stage); dialog.append(controls, viewport); document.body.append(dialog);
  function resize() {
    dialog.dispatchEvent(new Event("wm-visual-transform"));
    fit = Math.max(.01, Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    layout();
  }
  const disposeSelection = selection ? installVisualSelection(dialog, controls, stage, svg, selection) : undefined;
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  let gestureZoom = 1, gesturing = false;
  viewport.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (gesturing) return;
    const rect = viewport.getBoundingClientRect();
    setZoom(zoom * Math.exp(-event.deltaY * .01), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener("gesturestart", event => { event.preventDefault(); gestureZoom = zoom; gesturing = true; }, { passive: false });
  viewport.addEventListener("gesturechange", event => {
    event.preventDefault();
    setZoom(gestureZoom * (event as Event & { scale: number }).scale);
  }, { passive: false });
  viewport.addEventListener("gestureend", event => { event.preventDefault(); gesturing = false; }, { passive: false });
  function dispose() {
    if (closed) return;
    closed = true; if(activeViewer===dispose)activeViewer=undefined; observer.disconnect(); disposeSelection?.();
    if (!image) {
      if (originalStyle === null) svg.removeAttribute("style"); else svg.setAttribute("style", originalStyle);
      if (parent.isConnected) parent.append(svg);
    }
    dialog.remove();
    document.dispatchEvent(new Event('wm-visual-threads'));
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  dialog.addEventListener("close", dispose);
  activeViewer=dispose;
  dialog.showModal(); resize(); close.focus({ preventScroll: true });
  return dispose;
}

/** Add controls only after Crepe has installed its sanitized preview. */
export const diagramViewer = $prose(() => new Plugin({
  view: view => {
    viewerView = view;
    let close: (() => void) | undefined;
    let activePreview: HTMLElement | null = null;
    const controls = new Map<HTMLElement, () => void>();
    const sync = () => {
      if (activePreview && !activePreview.isConnected) { activePreview = null; }
      for (const [block, dispose] of controls) if (!view.dom.contains(block) || !block.querySelector(".wm-mermaid, .image-wrapper")) { dispose(); controls.delete(block); }
      for (const block of view.dom.querySelectorAll<HTMLElement>(".milkdown-code-block")) {
        if (controls.has(block) || !block.querySelector(".wm-mermaid svg")) continue;
        const tools = block.querySelector(".tools-button-group");
        if (!tools) continue;
        const button = document.createElement("button");
        button.type = "button"; button.className = "wm-diagram-expand";
        button.innerHTML = expandIcon + "Zoom";
        button.setAttribute("aria-label", "Expand diagram");
        const expand = () => {
          const svg = block.querySelector<SVGSVGElement>(".wm-mermaid svg");
          if (svg) { close?.(); activePreview = svg.parentElement; close = openDiagramViewer(svg, button, selectionOptions(svg, view)); }
        };
        button.addEventListener("click", expand);
        const pinch = (event: Event) => {
          if (event instanceof WheelEvent && !event.ctrlKey) return;
          const svg = block.querySelector<SVGSVGElement>(".wm-mermaid svg");
          if (!svg?.getClientRects().length) return;
          event.preventDefault();
          expand();
        };
        block.addEventListener("wheel", pinch, { passive: false });
        block.addEventListener("gesturestart", pinch, { passive: false });
        const comment = document.createElement('button');
        comment.type = 'button'; comment.className = 'wm-visual-comment';
        comment.innerHTML = iconSvg('message-square') + 'Comment';
        comment.onclick = () => {
          const svg = block.querySelector<SVGSVGElement>('.wm-mermaid svg');
          if (!svg) return;
          const options = selectionOptions(svg, view);
          if (options) { options.startSelecting = true; close = openDiagramViewer(svg, comment, options); }
        };
        tools.append(button, comment);
        controls.set(block, () => {
          block.removeEventListener("wheel", pinch);
          block.removeEventListener("gesturestart", pinch);
          button.remove(); comment.remove();
        });
      }
    };
    const syncImages = () => {
      for (const block of view.dom.querySelectorAll<HTMLElement>('.milkdown-image-block')) {
        if (controls.has(block)) continue;
        const operations = block.querySelector('.image-wrapper .operation');
        if (!operations) continue;
        const comment = document.createElement('button');
        comment.type = 'button'; comment.className = 'operation-item wm-visual-comment';
        comment.innerHTML = iconSvg('message-square') + 'Comment';
        comment.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
        comment.onclick = event => {
          event.preventDefault(); event.stopPropagation();
          const image = block.querySelector<HTMLImageElement>('.image-wrapper > img');
          if (!image?.naturalWidth) return;
          const options = selectionOptions(image, view);
          if (options) { options.startSelecting = true; close = openDiagramViewer(image, comment, options); }
        };
        operations.append(comment);
        controls.set(block, () => comment.remove());
      }
    };
    const badgeRecords = new Map<Element, { source: Element; signature: string; dispose: () => void }>();
    const syncBadges = () => {
      const groups = new Map<Element, { source: SVGSVGElement | HTMLImageElement; threads: AnnotationThread[] }>();
      for (const thread of visualThreads) {
        if (!thread.anchor.visual || thread.deleted) continue;
        const source = visualSource(view, thread.anchor);
        if (!source) continue;
        const block = source.closest('.milkdown-code-block, .milkdown-image-block') ?? source.parentElement!;
        const group = groups.get(block) ?? { source, threads: [] };
        group.threads.push(thread); groups.set(block, group);
      }
      for (const [block, record] of badgeRecords) if (!groups.has(block)) { record.dispose(); badgeRecords.delete(block); }
      for (const [block, {source, threads}] of groups) {
        const currentSource = selectionOptions(source,view)?.currentSource;
        const signature = JSON.stringify([currentSource, threads.map(t => [t.id,t.anchor,t.replies?.length ?? 0])]);
        if (badgeRecords.get(block)?.source === source && badgeRecords.get(block)?.signature === signature) continue;
        badgeRecords.get(block)?.dispose();
        let disposed = false;
        const cleanups: (() => void)[] = [];
        badgeRecords.set(block, {source, signature, dispose:()=>{disposed=true;cleanups.forEach(fn=>fn());}});
        void Promise.all(threads.map(t=>visualMatches(source,t.anchor,currentSource).catch(()=>false))).then(matches=>{
          if(disposed)return;
          const entries=threads.flatMap((t,i)=>matches[i]?[{anchor:t.anchor,label:String(1 + (t.replies?.length ?? 0)),open:()=>annotationBridge?.selectThread(t)}]:[]);
          if(entries.length)cleanups.push(regionLayer(source,block as HTMLElement,entries).remove);
          const stale=threads.filter((_,i)=>!matches[i]);
          if(stale.length){
            const badge=document.createElement('button');badge.type='button';badge.className='wm-visual-badge wm-visual-fallback';
            const count=stale.reduce((sum,t)=>sum+1+(t.replies?.length??0),0);
            badge.textContent=String(count);badge.setAttribute('aria-label',`${count} messages in earlier region threads`);
            badge.onclick=event=>{event.preventDefault();event.stopPropagation();annotationBridge?.selectThread(stale[0]!);};
            block.append(badge);cleanups.push(()=>badge.remove());
          }
        });
      }
    };
    const loadedImage = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      for (const [block, record] of badgeRecords) if (record.source === event.target) { record.dispose(); badgeRecords.delete(block); }
      syncBadges();
    };
    view.dom.addEventListener('load', loadedImage, true);
    document.addEventListener('wm-visual-threads',syncBadges);
    const openImage = (event: Event) => {
      if (event instanceof WheelEvent && !event.ctrlKey) return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !target.matches(documentImage) || !target.naturalWidth) return;
      event.preventDefault();
      close?.(); activePreview = target; close = openDiagramViewer(target, view.dom, selectionOptions(target, view));
    };
    view.dom.addEventListener("click", openImage);
    view.dom.addEventListener("wheel", openImage, { passive: false });
    view.dom.addEventListener("gesturestart", openImage, { passive: false });
    const observer = new MutationObserver(() => { sync(); syncImages(); syncBadges(); });
    observer.observe(view.dom, { childList: true, subtree: true }); sync(); syncImages();
    return { update: () => syncBadges(), destroy: () => {
      view.dom.removeEventListener('load', loadedImage, true);
      observer.disconnect(); for(const record of badgeRecords.values())record.dispose(); document.removeEventListener('wm-visual-threads',syncBadges); if(viewerView===view){viewerView=undefined;activeViewer?.();} close?.(); for (const dispose of controls.values()) dispose();
      view.dom.removeEventListener("click", openImage);
      view.dom.removeEventListener("wheel", openImage);
      view.dom.removeEventListener("gesturestart", openImage);
    } };
  },
}));
