import { dirname } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import {
  PROTOCOL_VERSION,
  SERVICE_ID,
  sessionRoutes,
  type AppPreferences,
  type DocumentSnapshot,
} from "../shared/contracts";
import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import { createBrowserHost } from "../hosts/browser";
import { HostGateway } from "../hosts/host-gateway";
import { DocumentService, DocumentAccessError, DocumentConflictError, DocumentNotFoundError, DocumentReadOnlyError, type AnnotationEventInput, type DocumentSession } from "../documents/document-service";
import { RecentsRegistry } from "../recents/registry";
import { RecentsService, type RecentsSnapshot } from "../recents/service";
import { moveToTrash, pickMarkdownFiles } from "../recents/actions";
import { ensureControlToken, prepareConfig, readControlToken, removeDiscovery, resolveConfig, writeDiscovery, type TetherConfig } from "./config";

const LOOPBACK = "127.0.0.1";
const DEFAULT_TICKET_MS = 30_000;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_STARTUP_GRACE_MS = 30_000;
const DEFAULT_IDLE_MS = 5_000;

export type Clock = () => number;
export type Ticket = { ticket: string; url: string; expiresAt: number };
export type Session = { id: string; grant: DocumentSession; cookie: string; createdAt: number; lastSeen: number; leases: Map<string, number>; target?: HostTarget };
type RecentsSession = { id: string; cookie: string; createdAt: number; lastSeen: number; leaseUntil: number; target?: HostTarget };

export type DaemonOptions = {
  config?: TetherConfig;
  port?: number;
  service?: DocumentService;
  recents?: RecentsRegistry;
  hostAdapter?: HostAdapter;
  now?: Clock;
  ticketMs?: number;
  leaseMs?: number;
  startupGraceMs?: number;
  idleMs?: number;
  actor?: string;
  /** A production web build can supply the extracted editor response. */
  web?: (request: Request, session: Session) => Response | Promise<Response>;
  opener?: (url: string) => Promise<void>;
  trashFile?: (path: string) => Promise<void>;
  pickFiles?: () => Promise<string[]>;
};

export type TetherDaemon = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  origin: string;
  instanceId: string;
  config: TetherConfig;
  ready: Promise<void>;
  closed: Promise<void>;
  stop: () => Promise<void>;
  mintTicket: (grant: DocumentSession, target?: HostTarget) => Ticket;
  service: DocumentService;
  sessions: ReadonlyMap<string, Session>;
};

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "content-type": "application/json; charset=utf-8", ...init.headers } });
}

function codedError(cause: unknown, fallbackCode: string, fallbackStatus: number): Response {
  const value = cause && typeof cause === "object" ? cause as { code?: unknown; status?: unknown; details?: unknown } : undefined;
  const code = typeof value?.code === "string" ? value.code : fallbackCode;
  const status = typeof value?.status === "number" ? value.status : fallbackStatus;
  return error(code, cause instanceof Error ? cause.message : String(cause), status, value?.details);
}

function error(code: string, message: string, status: number, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

function controlError(cause: unknown): Response {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof DocumentConflictError) return error("conflict", message, 409);
  if (cause instanceof DocumentReadOnlyError) return error("ledger_invalid", message, 422, cause.ledgerError);
  if (cause instanceof DocumentNotFoundError) return error("document_not_found", message, 404);
  if (cause instanceof DocumentAccessError) return error("document_unauthorized", message, 403);
  if (message.startsWith("Annotation thread not found:")) return error("thread_not_found", message, 404);
  return error("invalid_request", message || "Request failed.", 400);
}

export function sameOrigin(request: Request, origin: string): boolean {
  const value = request.headers.get("origin");
  if (value !== null) return value === origin;
  const referer = request.headers.get("referer");
  return referer !== null && (referer === `${origin}/` || referer.startsWith(`${origin}/`));
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const item of cookies) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new Error("Invalid JSON request.");
}

function textBody(body: Record<string, unknown>): string | undefined {
  const value = body.body ?? body.text;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventType(value: unknown): value is AnnotationEventInput["type"] {
  return value === "comment" || value === "reply" || value === "resolve" || value === "reopen" || value === "edit" || value === "delete" || value === "ack";
}

function selectEvent(body: Record<string, unknown>, forcedType?: string): AnnotationEventInput {
  const type = forcedType ?? body.type;
  if (!eventType(type)) throw new Error("Invalid annotation event type.");
  if (typeof body.actor !== "string" || !body.actor.trim()) throw new Error("An asserted actor is required.");
  const event: AnnotationEventInput = { ...body, type, actor: body.actor };
  for (const key of ["path", "expectedBodyRevision", "expectedRevision", "expectedLedgerRevision", "id", "seq", "createdAt", "through", "throughSeq"]) delete event[key];
  if (type !== "ack") delete event.bodyRevision;
  if (type === "ack") {
    const through = body.throughSeq ?? body.through;
    if (typeof through === "number") event.throughSeq = through;
    if (typeof body.bodyRevision === "string") event.bodyRevision = body.bodyRevision;
  }
  return event;
}

function expectedBodyRevision(body: Record<string, unknown>): string | undefined {
  const value = body.expectedBodyRevision ?? body.bodyRevision ?? body.expectedRevision;
  return typeof value === "string" ? value : undefined;
}

function hostTarget(value: unknown): HostTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function preferencesFrom(value: unknown): AppPreferences {
  const theme = value && typeof value === "object" && typeof (value as Record<string, unknown>).theme === "string" ? (value as Record<string, unknown>).theme : "frame-dark";
  const allowed = new Set<AppPreferences["theme"]>(["frame-dark", "crepe-dark", "nord-dark", "frame", "crepe", "nord"]);
  return { theme: allowed.has(theme as AppPreferences["theme"]) ? theme as AppPreferences["theme"] : "frame-dark" };
}

const fallbackHtml = `<!doctype html><meta charset="utf-8"><title>Tether</title><main id="app">Tether session</main>`;

/**
 * Create one loopback daemon. The document and Recents dependencies are
 * intentionally narrow so the lead can replace the filesystem fallback with
 * the extracted product services without changing this HTTP boundary.
 */
export function createDaemon(options: DaemonOptions = {}): TetherDaemon {
  const config = options.config ?? resolveConfig();
  const now = options.now ?? Date.now;
  const ticketMs = options.ticketMs ?? DEFAULT_TICKET_MS;
  const leaseMs = options.leaseMs ?? Number(process.env.TETHER_LEASE_MS ?? DEFAULT_LEASE_MS);
  const startupGraceMs = options.startupGraceMs ?? Number(process.env.TETHER_STARTUP_GRACE_MS ?? DEFAULT_STARTUP_GRACE_MS);
  const idleMs = options.idleMs ?? Number(process.env.TETHER_IDLE_MS ?? DEFAULT_IDLE_MS);
  const service = options.service ?? new DocumentService({ now });
  const trashFile = options.trashFile ?? moveToTrash;
  const pickFiles = options.pickFiles ?? (process.platform === "darwin" ? pickMarkdownFiles : undefined);
  const hostAdapter = options.hostAdapter ?? new HostGateway(config, createBrowserHost({ open: options.opener }));
  const recents = new RecentsService(options.recents ?? new RecentsRegistry({ path: config.recentsPath, now }), hostAdapter);
  const instanceId = crypto.randomUUID();
  const tickets = new Map<string, { grant: DocumentSession; expiresAt: number; target?: HostTarget }>();
  const recentsTickets = new Map<string, { expiresAt: number; target?: HostTarget }>();
  const sessions = new Map<string, Session>();
  const recentsSessions = new Map<string, RecentsSession>();
  const recentsStreamClosers = new Set<() => void>();
  const startedAt = now();
  let emptySince = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySettled = false;
  let pickerOpen = false;
  const settleReady = (cause?: unknown) => {
    if (readySettled) return;
    readySettled = true;
    if (cause === undefined) resolveReady(); else rejectReady(cause);
  };

  const originFor = (port: number) => `http://${LOOPBACK}:${port}`;
  let daemon!: TetherDaemon;

  function mintTicket(grant: DocumentSession, target?: HostTarget): Ticket {
    const ticket = randomToken();
    const expiresAt = now() + ticketMs;
    tickets.set(ticket, { grant, expiresAt, target });
    return { ticket, expiresAt, url: `${daemon.origin}/launch?ticket=${encodeURIComponent(ticket)}` };
  }

  function discardTicket(ticket: string): boolean {
    const pending = tickets.get(ticket);
    if (!pending) return false;
    tickets.delete(ticket);
    service.close(pending.grant);
    return true;
  }

  function discardLaunchTicket(ticket: string): boolean {
    if (discardTicket(ticket)) return true;
    return recentsTickets.delete(ticket);
  }

  function mintRecentsTicket(target?: HostTarget): Ticket {
    const ticket = randomToken();
    const expiresAt = now() + ticketMs;
    recentsTickets.set(ticket, { expiresAt, target });
    return { ticket, expiresAt, url: `${daemon.origin}/recents/launch?ticket=${encodeURIComponent(ticket)}` };
  }

  function recentsEventStream(request: Request): Response {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      request.signal.removeEventListener("abort", cleanup);
      recentsStreamClosers.delete(cleanup);
      try { controller?.close(); } catch { /* the stream may already be cancelled or errored */ }
    };
    const send = (value: string) => {
      if (closed || !controller) return;
      try { controller.enqueue(encoder.encode(value)); }
      catch { cleanup(); }
    };
    const sendSnapshot = (snapshot: RecentsSnapshot) => {
      send(`id: ${snapshot.sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        unsubscribe = recents.subscribe(sendSnapshot);
        recentsStreamClosers.add(cleanup);
        request.signal.addEventListener("abort", cleanup, { once: true });
        heartbeat = setInterval(() => send(": keepalive\n\n"), 20_000);
        void recents.snapshot().then(sendSnapshot).catch((cause) => {
          if (!closed) {
            try { controller?.error(cause); } catch { /* already closed */ }
          }
          cleanup();
        });
        if (request.signal.aborted) cleanup();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    } });
  }

  const recentsHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recents</title><style>
  #controls{grid-column:2 / -1;justify-self:end}
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font:15px system-ui;padding:24px}button{font:inherit}.button{padding:8px 11px;border:1px solid #444;border-radius:7px;background:#242424;color:inherit;cursor:pointer}.button:hover:not(:disabled){border-color:#777}.button:disabled{color:#777;cursor:default}#add{min-width:38px;font-size:20px;line-height:20px}.picker-slot{min-width:38px}#filter{width:100%;margin:0 0 12px;padding:9px 11px;border:1px solid #444;border-radius:7px;background:#1d1d1d;color:inherit;font:inherit;outline:none}#filter:focus{border-color:#888}.file-row{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;margin:8px 0}.file-row:not(.selecting){display:block}.file-check{width:17px;height:17px;margin:0 0 0 3px;accent-color:#8caee8}.file{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;width:100%;text-align:left;background:#1d1d1d;color:inherit;border:1px solid #333;border-radius:8px;padding:12px;cursor:pointer}.file-main{min-width:0}.name{font-weight:650}.dir{display:block;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}.time{color:#999;align-self:start;justify-self:end;text-align:right;white-space:nowrap}.empty,#status,#freshness{color:#999}#freshness{margin:0 0 10px}#freshness[hidden],#status:empty{display:none}.footer{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;margin-top:12px;min-height:38px}.controls{display:flex;gap:8px}#menu,#confirm-popover{position:fixed;z-index:10;display:none;min-width:190px;padding:5px;border:1px solid #444;border-radius:8px;background:#282d33;box-shadow:0 10px 28px #0008}#menu.open,#confirm-popover.open{display:block}#menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;cursor:pointer}#menu button:hover{background:#3a414a}#menu button[data-action="trash"],#batch-trash,#confirm-action.danger{color:#ff9898}#confirm-popover{width:min(300px,calc(100vw - 16px));padding:12px}#confirm-message{margin:0 0 12px}.confirm-actions{display:flex;justify-content:flex-end;gap:8px}@media(max-width:420px){body{padding:14px}.file{padding:10px}.time{font-size:12px}.footer{align-items:end}.controls{flex-wrap:wrap;justify-content:flex-end}}</style></head><body><input id="filter" type="search" placeholder="filter by filename" aria-label="Filter by filename" autocomplete="off"><p id="freshness" role="status" aria-live="polite" hidden></p><main id="list" aria-busy="true"></main><footer class="footer"><div class="picker-slot"><button id="add" class="button" aria-label="Add Markdown files" title="Add Markdown files"${pickFiles ? "" : " hidden"}>+</button></div><div id="status" role="status" aria-live="polite"></div><div id="controls" class="controls"><button id="batch-remove" class="button" hidden>Remove from Queue</button><button id="batch-trash" class="button" hidden>Move to Trash</button><button id="select" class="button">Select</button></div></footer><div id="menu" role="menu"><button data-action="reveal" role="menuitem">Reveal in Finder</button><button data-action="default" role="menuitem">Open in Default App</button><button data-action="remove" role="menuitem">Remove from Queue</button><button data-action="trash" role="menuitem">Move to Trash</button></div><div id="confirm-popover" role="dialog" aria-modal="true" aria-labelledby="confirm-message"><p id="confirm-message"></p><div class="confirm-actions"><button id="confirm-cancel" class="button">Cancel</button><button id="confirm-action" class="button">Confirm</button></div></div><script type="module">
  const api='./api';const pickerAvailable=${pickFiles !== undefined};const list=document.querySelector('#list');const status=document.querySelector('#status');const freshness=document.querySelector('#freshness');const menu=document.querySelector('#menu');const filter=document.querySelector('#filter');const controls=document.querySelector('#controls');const addButton=document.querySelector('#add');const selectButton=document.querySelector('#select');const batchRemove=document.querySelector('#batch-remove');const batchTrash=document.querySelector('#batch-trash');const confirmPopover=document.querySelector('#confirm-popover');const confirmMessage=document.querySelector('#confirm-message');const confirmAction=document.querySelector('#confirm-action');const confirmCancel=document.querySelector('#confirm-cancel');let files=[];let selectedPath=null;let selectionMode=false;let busy=false;let pendingBatchAction=null;let statusTimer=0;let lastSequence=-1;let verified=false;let revalidationFloor=-1;let revalidationToken=0;let errorRefreshQueued=false;const selected=new Set();
  const setStatus=(message)=>{clearTimeout(statusTimer);status.textContent=message;statusTimer=message?setTimeout(()=>{status.textContent='';statusTimer=0},10000):0};
  const closeMenu=()=>{menu.classList.remove('open');selectedPath=null};const openMenu=(event,path)=>{if(!verified||selectionMode)return;event.preventDefault();selectedPath=path;menu.classList.add('open');const bounds=menu.getBoundingClientRect();menu.style.left=Math.max(4,Math.min(event.clientX,innerWidth-bounds.width-4))+'px';menu.style.top=Math.max(4,Math.min(event.clientY,innerHeight-bounds.height-4))+'px'};
  const closeConfirm=()=>{confirmPopover.classList.remove('open');pendingBatchAction=null};const openConfirm=(action,anchor)=>{if(!selected.size||busy)return;pendingBatchAction=action;const count=selected.size;confirmMessage.textContent=action==='trash'?'Move '+count+' selected file'+(count===1?'':'s')+' to the Trash?':'Remove '+count+' selected file'+(count===1?'':'s')+' from the queue?';confirmAction.classList.toggle('danger',action==='trash');confirmPopover.classList.add('open');const anchorBounds=anchor.getBoundingClientRect();const bounds=confirmPopover.getBoundingClientRect();confirmPopover.style.left=Math.max(8,Math.min(anchorBounds.right-bounds.width,innerWidth-bounds.width-8))+'px';confirmPopover.style.top=Math.max(8,anchorBounds.top-bounds.height-8)+'px';confirmAction.focus()};
  const compactDirectory=path=>path.replace(/^\\/Users\\/[^/]+(?=\\/|$)/,'~');const compactTime=value=>{const date=new Date(value);const today=new Date();if(date.getFullYear()===today.getFullYear()&&date.getMonth()===today.getMonth()&&date.getDate()===today.getDate())return String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');return (date.getMonth()+1)+'/'+date.getDate()};
  const post=async(endpoint,body)=>{const response=await fetch(api+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error((await response.json()).error?.message||'Action failed');return response.json()};
  const renderControls=()=>{addButton.hidden=!pickerAvailable||selectionMode;addButton.disabled=busy||!verified;selectButton.textContent=selectionMode?'Cancel':'Select';batchRemove.hidden=!selectionMode;batchTrash.hidden=!selectionMode;batchRemove.disabled=busy||!verified||!selected.size;batchTrash.disabled=busy||!verified||!selected.size;selectButton.disabled=busy||!verified};
  const syncAvailability=()=>{list.inert=!verified;menu.inert=!verified;list.setAttribute('aria-busy',String(!verified));renderControls()};
  const render=()=>{const paths=new Set(files.map(file=>file.path));let selectionChanged=false;for(const path of selected)if(!paths.has(path)){selected.delete(path);selectionChanged=true}if(selectedPath&&!paths.has(selectedPath))closeMenu();if(selectionChanged&&confirmPopover.classList.contains('open'))closeConfirm();const query=filter.value.trim().toLocaleLowerCase();const visible=files.filter(file=>file.name.toLocaleLowerCase().includes(query));list.innerHTML=visible.length?'':'<p class="empty">'+(files.length?'No matching files.':'No recent Markdown files.')+'</p>';for(const file of visible){const row=document.createElement('div');row.className='file-row'+(selectionMode?' selecting':'');if(selectionMode){const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='file-check';checkbox.checked=selected.has(file.path);checkbox.setAttribute('aria-label','Select '+file.name);checkbox.onchange=()=>{checkbox.checked?selected.add(file.path):selected.delete(file.path);renderControls()};row.append(checkbox)}const b=document.createElement('button');b.className='file';b.innerHTML='<span class="file-main"><span class="name"></span><br><span class="dir"></span></span><span class="time"></span>';b.querySelector('.name').textContent=file.name;const directory=compactDirectory(file.directory);const dir=b.querySelector('.dir');const dirValue=document.createElement('bdi');dirValue.dir='ltr';dirValue.textContent=directory;dir.append(dirValue);dir.title=directory;b.querySelector('.time').textContent=compactTime(file.createdAt);b.onclick=async()=>{if(!verified)return;if(selectionMode){selected.has(file.path)?selected.delete(file.path):selected.add(file.path);render();return}b.disabled=true;setStatus('Opening…');try{await post('open',{path:file.path});setStatus('Opened.')}catch(error){setStatus(error.message)}finally{b.disabled=false}};b.addEventListener('contextmenu',(event)=>openMenu(event,file.path));row.append(b);list.append(row)}syncAvailability()};
  const setUnverified=(message='')=>{verified=false;freshness.hidden=!message;freshness.textContent=message;closeConfirm();syncAvailability()};
  const applySnapshot=(snapshot,mayVerify=false)=>{if(!snapshot||!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<0||!Array.isArray(snapshot.files)||snapshot.sequence<=lastSequence)return false;const changed=!list.firstChild||JSON.stringify(files)!==JSON.stringify(snapshot.files);lastSequence=snapshot.sequence;files=snapshot.files;if(!verified&&(mayVerify||snapshot.sequence>revalidationFloor)){verified=true;freshness.hidden=true;freshness.textContent=''}if(changed){closeMenu();render()}else syncAvailability();return true};
  const refreshFiles=async(token=null,required=false)=>{const baseline=lastSequence;try{const r=await fetch(api+'/snapshot');if(!r.ok){if(r.status===401){files=[];lastSequence=-1;setUnverified('Session expired.')}else if(required&&token===revalidationToken&&lastSequence<=baseline)setUnverified('Unable to verify Recents; retrying…');return}applySnapshot(await r.json(),token===null||token===revalidationToken)}catch{if(required&&token===revalidationToken&&lastSequence<=baseline)setUnverified('Unable to verify Recents; retrying…')}};
  const revalidate=()=>{revalidationFloor=lastSequence;const token=++revalidationToken;setUnverified();void refreshFiles(token,true)};
  const runBatch=async()=>{const action=pendingBatchAction;if(!action)return;const paths=[...selected];closeConfirm();busy=true;renderControls();setStatus('Working…');let completed=0;try{for(const path of paths){await post('action',{path,action});selected.delete(path);completed++}selectionMode=false;selected.clear();setStatus(action==='trash'?'Moved '+completed+' file'+(completed===1?'':'s')+' to Trash.':'Removed '+completed+' file'+(completed===1?'':'s')+' from queue.')}catch(error){setStatus(error.message)}finally{await refreshFiles();busy=false;renderControls()}};
  addButton.addEventListener('click',async()=>{if(!verified||busy||selectionMode||!pickerAvailable)return;busy=true;renderControls();try{const result=await post('pick',{});if(!result.cancelled){await refreshFiles();setStatus('Added '+result.added+' file'+(result.added===1?'':'s')+'.')}}catch(error){setStatus(error.message)}finally{busy=false;renderControls()}});
  selectButton.addEventListener('click',()=>{if(!verified)return;if(selectionMode){selectionMode=false;selected.clear();closeConfirm()}else selectionMode=true;render()});batchRemove.addEventListener('click',()=>openConfirm('remove',batchRemove));batchTrash.addEventListener('click',()=>openConfirm('trash',batchTrash));confirmCancel.addEventListener('click',closeConfirm);confirmAction.addEventListener('click',runBatch);
  menu.addEventListener('click',async(event)=>{const button=event.target.closest('button[data-action]');if(!button||!selectedPath)return;const action=button.dataset.action;const path=selectedPath;closeMenu();if(action==='trash'&&!confirm('Move this file to the Trash?'))return;setStatus('Working…');try{await post('action',{path,action});setStatus('');if(action==='remove'||action==='trash')await refreshFiles()}catch(error){setStatus(error.message)}});
  filter.addEventListener('input',render);document.addEventListener('click',(event)=>{if(!menu.contains(event.target))closeMenu();if(confirmPopover.classList.contains('open')&&!confirmPopover.contains(event.target)&&!controls.contains(event.target))closeConfirm()});document.addEventListener('keydown',(event)=>{if(event.key==='Escape'){closeMenu();closeConfirm()}});document.addEventListener('visibilitychange',()=>{if(document.hidden)setUnverified();else revalidate()});addEventListener('pagehide',()=>setUnverified());addEventListener('pageshow',revalidate);addEventListener('scroll',closeMenu,true);if(typeof EventSource!=='undefined'){const events=new EventSource(api+'/events');events.addEventListener('snapshot',(event)=>{try{applySnapshot(JSON.parse(event.data))}catch{}});events.onerror=()=>{if(errorRefreshQueued)return;errorRefreshQueued=true;queueMicrotask(()=>{errorRefreshQueued=false;revalidate()})}}setInterval(()=>fetch(api+'/lease',{method:'POST'}),30000);fetch(api+'/lease',{method:'POST'});revalidate();
  </script></body></html>`;

  function sessionFrom(request: Request, pathname: string): Session | Response {
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return error("invalid_session", "The browser session route is invalid.", 404);
    let id: string;
    try { id = decodeURIComponent(match[1]); } catch { return error("invalid_session", "The browser session route is invalid.", 404); }
    const session = sessions.get(id);
    if (!session) return error("session_expired", "The browser session has expired.", 401);
    if (cookieValue(request, "tether_session") !== session.cookie) return error("unauthorized", "A scoped browser session cookie is required.", 401);
    session.lastSeen = now();
    return session;
  }

  async function preferences(): Promise<AppPreferences> {
    try { return preferencesFrom(JSON.parse(await readFile(config.preferencesPath, "utf8"))); } catch { return preferencesFrom(null); }
  }

  async function withControlDocument<T>(body: Record<string, unknown>, operation: (grant: DocumentSession) => Promise<T>): Promise<T> {
    if (typeof body.path !== "string" || !body.path.trim()) throw new Error("A Markdown path is required.");
    const grant = await service.open(body.path);
    try { return await operation(grant); }
    finally { service.close(grant); }
  }

  function mutationSummary(document: DocumentSnapshot): Record<string, unknown> {
    return {
      path: document.path,
      bodyRevision: document.bodyRevision,
      ledgerRevision: document.ledgerRevision,
      maxSequence: document.annotations.maxSequence,
      unresolvedCount: document.annotations.unresolvedCount,
    };
  }

  async function sessionApi(request: Request, session: Session, path: string): Promise<Response> {
    const apiPath = path.replace(/^\/s\/[^/]+\/api/, "") || "/";
    const stateChanging = request.method !== "GET" && request.method !== "HEAD";
    if (stateChanging && !sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
    try {
      if (apiPath === "/bootstrap" && request.method === "GET") {
        const document = await service.read(session.grant);
        return json({ protocol: PROTOCOL_VERSION, sessionId: session.id, document, capabilities: hostAdapter.capabilities(session.target), preferences: await preferences(), actor: options.actor ?? "assistant" });
      }
      if (apiPath === "/file" && request.method === "GET") return json(await service.read(session.grant));
      if (apiPath === "/file" && request.method === "PUT") {
        const body = await requestJson(request);
        const content = typeof body.content === "string" ? body.content : typeof body.body === "string" ? body.body : undefined;
        const expected = expectedBodyRevision(body);
        if (content === undefined || !expected) return error("invalid_request", "A body and expectedBodyRevision are required.", 400);
        return json(await service.saveBody({ session: session.grant, body: content, expectedBodyRevision: expected }));
      }
      if (apiPath === "/annotations" && request.method === "GET") {
        const actor = new URL(request.url).searchParams.get("actor") ?? options.actor ?? "assistant";
        const pending = await service.pendingRead(session.grant, actor);
        return json(pending);
      }
      if (apiPath === "/annotations/pending" && (request.method === "GET" || request.method === "POST")) {
        const body = request.method === "POST" ? await requestJson(request) : {};
        const actor = typeof body.actor === "string" ? body.actor : new URL(request.url).searchParams.get("actor") ?? options.actor ?? "assistant";
        return json(await service.pendingRead(session.grant, actor));
      }
      if (apiPath === "/annotations/thread" && request.method === "GET") {
        const threadId = new URL(request.url).searchParams.get("threadId") ?? new URL(request.url).searchParams.get("id");
        if (!threadId) return error("invalid_request", "A thread ID is required.", 400);
        return json(await service.thread(session.grant, threadId));
      }
      const action = /^\/annotations\/(reply|resolve|reopen|edit|delete|acknowledge)$/.exec(apiPath)?.[1];
      if (action && request.method === "POST") {
        const body = await requestJson(request);
        let event: AnnotationEventInput;
        if (action === "reply") {
          if (!textBody(body) || typeof body.threadId !== "string") throw new Error("A reply needs threadId and body.");
          event = selectEvent({ ...body, type: "reply", body: textBody(body) }, "reply");
        } else if (action === "edit") {
          if (!textBody(body) || typeof body.threadId !== "string" || typeof body.targetId !== "string") throw new Error("An edit needs threadId, targetId, and body.");
          event = selectEvent({ ...body, type: "edit", body: textBody(body) }, "edit");
        } else if (action === "delete") {
          if (typeof body.threadId !== "string" || typeof body.targetId !== "string") throw new Error("A delete event needs threadId and targetId.");
          event = selectEvent({ ...body, type: "delete" }, "delete");
        } else if (action === "acknowledge") {
          if (!Number.isSafeInteger(body.through) || (body.through as number) < 1 || typeof body.bodyRevision !== "string") throw new Error("An acknowledgement needs through and bodyRevision.");
          event = selectEvent({ ...body, type: "ack", throughSeq: body.through }, "ack");
        } else {
          if (typeof body.threadId !== "string") throw new Error(`A ${action} event needs threadId.`);
          event = selectEvent({ ...body, type: action }, action);
        }
        return json(await service.appendEvent({ session: session.grant, event, expectedBodyRevision: action === "acknowledge" ? body.bodyRevision as string : expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/annotations" && request.method === "POST") {
        const body = await requestJson(request);
        return json(await service.appendEvent({ session: session.grant, event: selectEvent(body), expectedBodyRevision: expectedBodyRevision(body), expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined }));
      }
      if (apiPath === "/lease" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId !== "string" || !body.clientId) return error("invalid_client", "A lease clientId is required.", 400);
        const leaseId = body.clientId;
        session.leases.set(leaseId, now() + leaseMs);
        emptySince = 0;
        const read = await service.read(session.grant);
        return json({ bodyRevision: read.bodyRevision, ledgerRevision: read.ledgerRevision, revision: read.bodyRevision });
      }
      if (apiPath === "/release" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.clientId === "string") session.leases.delete(body.clientId);
        // A pagehide beacon also fires during reload, browser suspension, and
        // host-managed webview transitions. It releases presence only; the
        // document-scoped authorization remains valid until explicit daemon
        // shutdown.
        session.lastSeen = now();
        return json({ ok: true });
      }
      if (apiPath === "/open" && request.method === "POST") {
        const body = await requestJson(request);
        if (typeof body.target !== "string" || !body.target.trim()) throw new Error("A wikilink target is required.");
        const grant = await resolveTarget(session.grant.path, body.target, service);
        const ticket = mintTicket(grant, session.target);
        try { await hostAdapter.openView({ url: ticket.url, kind: "document", focus: true, allowFocusedFallback: true, target: session.target }); }
        catch (cause) { discardTicket(ticket.ticket); throw cause; }
        return json({ path: grant.path, resolvedPath: grant.realPath, opened: true });
      }
      if (apiPath === "/preferences" && request.method === "PUT") {
        const body = await requestJson(request);
        const value = preferencesFrom(body);
        const { mkdir, writeFile, rename } = await import("node:fs/promises");
        await mkdir(dirname(config.preferencesPath), { recursive: true, mode: 0o700 });
        const temp = `${config.preferencesPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        await rename(temp, config.preferencesPath);
        return json(value);
      }
      return error("not_found", "API endpoint not found.", 404);
    } catch (cause) {
      const status = cause instanceof DocumentConflictError ? 409 : cause instanceof DocumentReadOnlyError ? 422 : 400;
      if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return codedError(cause, "invalid_request", status);
      return error(status === 409 ? "conflict" : status === 422 ? "ledger_invalid" : "invalid_request", (cause as Error).message || "Request failed.", status);
    }
  }

  async function resolveTarget(currentPath: string, rawTarget: string, documents: DocumentService): Promise<DocumentSession> {
    const resolved = await documents.resolveWikilink(currentPath, rawTarget);
    return documents.open(resolved);
  }

  async function requestHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId });
    if (pathname === "/launch" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket");
      if (!ticket) return error("ticket_missing", "A launch ticket is required.", 400);
      const pending = tickets.get(ticket);
      if (!pending) return error("ticket_invalid", "The launch ticket is invalid or already used.", 401);
      tickets.delete(ticket);
      if (pending.expiresAt <= now()) {
        service.close(pending.grant);
        return error("ticket_expired", "The launch ticket has expired.", 401);
      }
      const id = randomToken();
      const createdAt = now();
      const session: Session = { id, grant: pending.grant, cookie: randomToken(), createdAt, lastSeen: createdAt, leases: new Map(), ...(pending.target ? { target: pending.target } : {}) };
      sessions.set(id, session);
      try { await recents.record(pending.grant.realPath, pending.target); }
      catch (cause) {
        sessions.delete(id);
        service.close(pending.grant);
        return error("launch_failed", cause instanceof Error ? cause.message : String(cause), 500);
      }
      const root = sessionRoutes(id).root;
      return new Response(null, { status: 302, headers: {
        location: root,
        "set-cookie": `tether_session=${session.cookie}; Path=${root}; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      } });
    }
    if (pathname === "/recents/launch" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket");
      const pending = ticket ? recentsTickets.get(ticket) : undefined;
      if (!ticket || !pending) return error("ticket_invalid", "The Recents launch ticket is invalid or already used.", 401);
      recentsTickets.delete(ticket);
      if (pending.expiresAt <= now()) return error("ticket_expired", "The Recents launch ticket has expired.", 401);
      const id = randomToken();
      const createdAt = now();
      const session: RecentsSession = { id, cookie: randomToken(), createdAt, lastSeen: createdAt, leaseUntil: createdAt + leaseMs, ...(pending.target ? { target: pending.target } : {}) };
      recentsSessions.set(id, session);
      const root = `/r/${encodeURIComponent(id)}/`;
      return new Response(null, { status: 302, headers: {
        location: `${root}?instance=${encodeURIComponent(daemon.instanceId)}`,
        "set-cookie": `tether_recents=${session.cookie}; Path=${root}; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store", "referrer-policy": "no-referrer",
      } });
    }
    if (pathname.startsWith("/r/")) {
      const match = /^\/r\/([^/]+)\/(.*)$/.exec(pathname);
      const session = match ? recentsSessions.get(decodeURIComponent(match[1])) : undefined;
      if (!session) return error("session_expired", "The Recents session has expired.", 401);
      if (cookieValue(request, "tether_recents") !== session.cookie) return error("unauthorized", "A scoped Recents cookie is required.", 401);
      session.lastSeen = now();
      const suffix = `/${match![2]}`;
      if (request.method === "GET" && suffix === "/") return new Response(recentsHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (request.method === "GET" && suffix === "/api/files") return json(await recents.files());
      if (request.method === "GET" && suffix === "/api/snapshot") return json(await recents.snapshot());
      if (request.method === "GET" && suffix === "/api/events") return recentsEventStream(request);
      if (request.method === "POST" && suffix === "/api/lease") { session.leaseUntil = now() + leaseMs; return json({ ok: true }); }
      if (request.method === "POST" && suffix === "/api/pick") {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        if (!pickFiles) return error("picker_unavailable", "The native Markdown picker is unavailable on this platform.", 501);
        if (pickerOpen) return error("picker_busy", "The native Markdown picker is already open.", 409);
        pickerOpen = true;
        try {
          const paths = await pickFiles();
          if (!paths.length) return json({ cancelled: true, added: 0 });
          const result = await recents.recordMany(paths, session.target);
          return json({ cancelled: false, added: result.added.length });
        } catch (cause) { return codedError(cause, "pick_failed", 400); }
        finally { pickerOpen = false; }
      }
      if (request.method === "POST" && suffix === "/api/open") {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = await requestJson(request);
          if (typeof body.path !== "string") throw new Error("A recent Markdown path is required.");
          const allowed = await recents.paths();
          const grant = await service.open(body.path);
          if (!allowed.includes(grant.realPath)) { service.close(grant); return error("document_unauthorized", "The path is not in Tether Recents.", 403); }
          const launch = mintTicket(grant, session.target);
          try {
            await hostAdapter.openView({
              url: launch.url,
              kind: "document",
              focus: true,
              allowFocusedFallback: true,
              ...(session.target?.host === "cmux" ? { targetPolicy: "focused-workspace" as const } : {}),
              target: session.target,
            });
          }
          catch (cause) { discardTicket(launch.ticket); throw cause; }
          return json({ opened: true, path: grant.path });
        } catch (cause) { return codedError(cause, "open_failed", 400); }
      }
      if (request.method === "POST" && suffix === "/api/action") {
        if (!sameOrigin(request, daemon.origin)) return error("origin_mismatch", "State-changing requests must use the daemon origin.", 403);
        try {
          const body = await requestJson(request);
          if (typeof body.path !== "string" || typeof body.action !== "string") throw new Error("A recent Markdown path and action are required.");
          const path = await realpath(body.path);
          if (!(await recents.paths()).includes(path)) return error("document_unauthorized", "The path is not in Tether Recents.", 403);
          switch (body.action) {
            case "reveal":
              if (!hostAdapter.capabilities(session.target).revealFile || !hostAdapter.revealFile) throw new Error("Reveal in Finder is unavailable in this host.");
              await hostAdapter.revealFile(path);
              break;
            case "default":
              await hostAdapter.openExternal(path);
              break;
            case "remove":
              await recents.remove(path, session.target);
              break;
            case "trash":
              await trashFile(path);
              await recents.remove(path, session.target);
              break;
            default:
              throw new Error("Unknown recent-file action.");
          }
          return json({ action: body.action, path });
        } catch (cause) { return error("action_failed", cause instanceof Error ? cause.message : String(cause), 400); }
      }
      return error("not_found", "Recents resource not found.", 404);
    }
    if (pathname.startsWith("/control/")) {
      const expected = await readControlToken(config);
      if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return error("forbidden", "Control authorization is required.", 403);
      try {
        if (pathname === "/control/launch" && request.method === "POST") {
          const body = await requestJson(request);
          const grant = await service.open(typeof body.path === "string" ? body.path : "");
          const target = hostTarget(body.target);
          const ticket = mintTicket(grant, target);
          return json({ ...ticket, path: grant.path });
        }
        if (pathname === "/control/recents/launch" && request.method === "POST") {
          const body = await requestJson(request);
          return json(mintRecentsTicket(hostTarget(body.target)));
        }
        if (pathname === "/control/recents/add" && request.method === "POST") {
          try {
            const body = await requestJson(request);
            if (typeof body.path !== "string" || !body.path.trim()) throw new Error("A recent Markdown path is required.");
            const result = await recents.record(body.path, hostTarget(body.target));
            return json({ path: result.entry.path, recentCount: result.entries.length, hostSynchronized: result.hostSynchronized });
          } catch (cause) {
            return error("command_failed", cause instanceof Error ? cause.message : String(cause), 500);
          }
        }
        if (pathname === "/control/cancel" && request.method === "POST") {
          const body = await requestJson(request);
          if (typeof body.ticket !== "string" || !body.ticket) return error("invalid_request", "A launch ticket is required.", 400);
          return json({ cancelled: discardLaunchTicket(body.ticket) });
        }
        if (request.method === "POST" && (pathname.startsWith("/control/document/") || pathname.startsWith("/control/review/"))) {
          const body = await requestJson(request);
          const result = await withControlDocument(body, async (grant) => {
            if (pathname === "/control/document/read") return await service.read(grant);
            if (pathname === "/control/document/save") {
              if (typeof body.body !== "string" || typeof body.expectedBodyRevision !== "string") throw new Error("Document save requires body and expectedBodyRevision.");
              return mutationSummary(await service.saveBody({ session: grant, body: body.body, expectedBodyRevision: body.expectedBodyRevision }));
            }
            if (pathname === "/control/review/pending") {
              if (typeof body.actor !== "string" || !body.actor.trim()) throw new Error("Pending review requires actor.");
              const pending = await service.pendingRead(grant, body.actor);
              return {
                path: pending.path,
                documentId: pending.documentId,
                bodyRevision: pending.bodyRevision,
                ledgerRevision: pending.ledgerRevision,
                events: pending.events.map(({ event }) => event),
                maxSequence: pending.maxSequence,
                acknowledgement: pending.acknowledgement,
              };
            }
            if (pathname === "/control/review/thread") {
              if (typeof body.threadId !== "string" || !body.threadId) throw new Error("A thread ID is required.");
              return await service.thread(grant, body.threadId);
            }
            const action = /^\/control\/review\/(reply|resolve|reopen|acknowledge)$/.exec(pathname)?.[1];
            if (!action) throw new Error("Control endpoint not found.");
            if (typeof body.actor !== "string" || !body.actor.trim()) throw new Error(`Review ${action} requires actor.`);
            let event: AnnotationEventInput;
            if (action === "reply") {
              if (typeof body.threadId !== "string" || !textBody(body)) throw new Error("A reply needs threadId and body.");
              event = selectEvent({ ...body, type: "reply", body: textBody(body) }, "reply");
            } else if (action === "acknowledge") {
              if (!Number.isSafeInteger(body.through) || (body.through as number) < 1 || typeof body.bodyRevision !== "string") throw new Error("An acknowledgement needs through and bodyRevision.");
              event = selectEvent({ ...body, type: "ack", throughSeq: body.through }, "ack");
            } else {
              if (typeof body.threadId !== "string" || !body.threadId) throw new Error(`A ${action} event needs threadId.`);
              event = selectEvent({ ...body, type: action }, action);
            }
            return mutationSummary(await service.appendEvent({
              session: grant,
              event,
              expectedBodyRevision: action === "acknowledge" ? body.bodyRevision as string : undefined,
              expectedLedgerRevision: typeof body.expectedLedgerRevision === "string" ? body.expectedLedgerRevision : undefined,
            }));
          });
          return json(result);
        }
        if (pathname === "/control/status" && request.method === "GET") return json({ service: SERVICE_ID, protocol: PROTOCOL_VERSION, instanceId, origin: daemon.origin, pid: process.pid, sessions: sessions.size });
        if (pathname === "/control/stop" && request.method === "POST") { queueMicrotask(() => { void daemon.stop(); }); return json({ stopping: true }); }
      } catch (cause) { return controlError(cause); }
      return error("not_found", "Control endpoint not found.", 404);
    }
    if (pathname.startsWith("/s/")) {
      const session = sessionFrom(request, pathname);
      if (session instanceof Response) return session;
      const sessionRoot = sessionRoutes(session.id).root;
      const suffix = pathname.slice(sessionRoot.length - 1);
      if (suffix.startsWith("/api/")) return sessionApi(request, session, pathname);
      if (options.web) return options.web(request, session);
      if (suffix === "/" || suffix === "") return new Response(fallbackHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      return error("not_found", "Session resource not found.", 404);
    }
    return error("not_found", "Not found.", 404);
  }

  const bunServer = Bun.serve({ hostname: LOOPBACK, port: options.port ?? 0, fetch: requestHandler });
  const boundPort = bunServer.port!;
  daemon = {
    server: bunServer,
    port: boundPort,
    origin: originFor(boundPort),
    instanceId,
    config,
    service,
    ready,
    closed,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const session of sessions.values()) service.close(session.grant);
      sessions.clear();
      for (const pending of tickets.values()) service.close(pending.grant);
      tickets.clear();
      recentsTickets.clear();
      recentsSessions.clear();
      for (const close of [...recentsStreamClosers]) close();
      await bunServer.stop();
      await removeDiscovery(config, instanceId);
      settleReady();
      resolveClosed();
    },
    mintTicket,
    sessions,
  };

  void (async () => {
    try {
      await prepareConfig(config);
      if (stopped) return;
      await ensureControlToken(config);
      if (stopped) return;
      await writeDiscovery(config, { protocol: PROTOCOL_VERSION, instanceId, pid: process.pid, origin: daemon.origin, startedAt: new Date(startedAt).toISOString() });
      if (stopped) { await removeDiscovery(config, instanceId); return; }
      timer = setInterval(() => {
        const current = now();
        for (const session of [...sessions.values()]) {
          for (const [lease, expiry] of session.leases) if (expiry <= current) session.leases.delete(lease);
        }
        for (const [ticket, pending] of tickets) {
          if (pending.expiresAt <= current) {
            tickets.delete(ticket);
            service.close(pending.grant);
          }
        }
        for (const [ticket, pending] of recentsTickets) if (pending.expiresAt <= current) recentsTickets.delete(ticket);
        const active = sessions.size > 0 || recentsSessions.size > 0 || tickets.size > 0 || recentsTickets.size > 0;
        if (active) { emptySince = 0; return; }
        if (emptySince === 0) emptySince = current;
        const grace = current - startedAt < startupGraceMs ? startupGraceMs : idleMs;
        if (current - emptySince >= grace) void daemon.stop();
      }, 500);
      settleReady();
    } catch (cause) { settleReady(cause); void daemon.stop(); }
  })();

  return daemon;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<TetherDaemon> {
  let configured = options;
  if (!configured.web) {
    const { createWebBundleResponder } = await import("../web/bundle");
    const responder = await createWebBundleResponder();
    configured = { ...options, web: (request) => responder(request) };
  }
  const daemon = createDaemon(configured);
  await daemon.ready;
  return daemon;
}

export async function createLaunchTicket(daemon: TetherDaemon, path: string): Promise<Ticket> {
  return daemon.mintTicket(await daemon.service.open(path));
}
