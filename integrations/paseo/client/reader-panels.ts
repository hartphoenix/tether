import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { ackRpc } from "../shared/contracts";
import { getState, setPanelOpener, subscribeState, type Delivery } from "./state";
import { isDesktop } from "./web";

/**
 * Readers as plugin panels, without a browser's address bar. A panel's tab
 * title is fixed at registration and Paseo keeps one tab per panel per
 * workspace, so each document gets its own panel, registered at runtime.
 * Paseo saves open tabs in its layout; registrations are saved too and
 * restored at startup so those tabs resolve.
 *
 * Opens arrive as intents. A user's open focuses the document's tab; a
 * mounted panel that asked for a fresh launch receives it without moving focus.
 */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type PanelHost = Pick<PluginClientContext, "addWorkspacePanel" | "openPanel" | "rpc">;
export type ReaderDocument = { path: string; name: string };
export type ReaderComponent = (panelId: string) => ComponentType<PluginWorkspacePanelProps>;

const PANELS_KEY = "tether.reader-panels.v1";
const SESSIONS_KEY = "tether.reader-sessions.v1";
const MAX_SAVED = 100;
const RELAUNCH_MS = 30_000;

const documents = new Map<string, ReaderDocument>();
const removals = new Map<string, () => void>();
// Launch URLs for panels that haven't mounted yet, by panel and workspace.
const pending = new Map<string, string>();
// Mounted panels waiting for a fresh launch they requested.
const waiters = new Map<string, (url: string) => void>();
const relaunching = new Map<string, number>();
const mounted = new Map<string, (url: string) => void>();
let host: PanelHost | null = null;
let component: ReaderComponent | null = null;
let storage: Storage | null = null;

const parse = (key: string): any => {
  try { return JSON.parse(storage?.getItem(key) ?? "null"); } catch { return null; }
};
const write = (key: string, value: unknown) => { try { storage?.setItem(key, JSON.stringify(value)); } catch {} };
const launchKey = (panelId: string, workspaceId: string) => JSON.stringify([panelId, workspaceId]);

export function fileName(path: string): string {
  return path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") || path;
}

/** Panel IDs allow only lowercase letters, digits, and hyphens; two 32-bit hashes of the path fit. */
export function readerPanelId(path: string): string {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `reader-${hex(a)}${hex(b)}`;
}

export function readerDocument(panelId: string): ReaderDocument | undefined { return documents.get(panelId); }

function register(panelId: string, document: ReaderDocument): void {
  if (!host || !component || documents.has(panelId)) return;
  removals.set(panelId, host.addWorkspacePanel({
    id: panelId, title: document.name, icon: "FileText", context: "workspace", locations: ["workspace"], Component: component(panelId),
  }));
  documents.set(panelId, document);
}

function saveDocuments(): void {
  write(PANELS_KEY, Object.fromEntries([...documents].slice(-MAX_SAVED)));
}

/** Reader panel IDs in Paseo's saved layout, or null when the layout isn't readable. */
export function openReaderPanels(source: Storage): Set<string> | null {
  let layouts: unknown;
  try { layouts = JSON.parse(source.getItem("workspace-layout-state") ?? "null")?.state?.layoutByWorkspace; } catch { return null; }
  if (!layouts || typeof layouts !== "object") return null;
  const ids = new Set<string>();
  let panes = 0;
  const walk = (node: any): void => {
    if (node?.kind === "group") for (const child of node.group?.children ?? []) walk(child);
    if (node?.kind !== "pane") return;
    panes++;
    for (const tab of node.pane?.tabs ?? []) {
      const target = tab?.target;
      if (target?.kind === "plugin" && target.pluginId === "tether" && typeof target.panelId === "string") ids.add(target.panelId);
    }
  };
  for (const layout of Object.values(layouts)) walk((layout as any)?.root);
  // An unrecognized layout must not forget panels that restored tabs still need.
  return panes ? ids : null;
}

/** The panel opener: registers the document's panel, hands it the launch, and focuses it unless it asked. */
export function openReader(intent: Delivery): void {
  if (!host || !intent.path) return;
  const panelId = readerPanelId(intent.path);
  if (!documents.has(panelId)) {
    register(panelId, { path: intent.path, name: getState().folio?.find(entry => entry.path === intent.path)?.name ?? fileName(intent.path) });
    saveDocuments();
  }
  const key = launchKey(panelId, intent.workspaceId);
  const requested = (relaunching.get(key) ?? 0) > Date.now();
  relaunching.delete(key);
  const waiter = waiters.get(key);
  const reopen = mounted.get(key);
  if (waiter) { waiters.delete(key); waiter(intent.url); }
  // An open tab keeps its session unless the link targets a heading.
  else if (reopen) { if (new URL(intent.url).hash) reopen(intent.url); }
  else pending.set(key, intent.url);
  if (!requested) host.openPanel(panelId, { workspaceId: intent.workspaceId, location: "workspace" });
}

/** A launch handed to this panel before it mounted. */
export function takeLaunch(panelId: string, workspaceId: string): string | undefined {
  const key = launchKey(panelId, workspaceId);
  const url = pending.get(key);
  pending.delete(key);
  return url;
}

/** Ask Tether for a fresh launch; it returns as an intent that doesn't move focus. */
export function relaunch(panelId: string, workspaceId: string, request: () => Promise<unknown>): Promise<string> {
  const key = launchKey(panelId, workspaceId);
  return new Promise((resolve, reject) => {
    waiters.set(key, resolve);
    relaunching.set(key, Date.now() + RELAUNCH_MS);
    request().catch(cause => {
      if (waiters.get(key) === resolve) waiters.delete(key);
      relaunching.delete(key);
      reject(cause);
    });
  });
}

/** While mounted, a panel takes launches that target a heading. */
export function mountReader(panelId: string, workspaceId: string, reopen: (url: string) => void): () => void {
  const key = launchKey(panelId, workspaceId);
  mounted.set(key, reopen);
  return () => {
    if (mounted.get(key) === reopen) mounted.delete(key);
    waiters.delete(key);
  };
}

export function savedSession(cacheKey: string): string | undefined {
  const value = parse(SESSIONS_KEY)?.[cacheKey];
  return typeof value === "string" ? value : undefined;
}

export function saveSession(cacheKey: string, url: string | undefined): void {
  const sessions: Record<string, string> = { ...(parse(SESSIONS_KEY) ?? {}) };
  delete sessions[cacheKey];
  if (url) sessions[cacheKey] = url;
  write(SESSIONS_KEY, Object.fromEntries(Object.entries(sessions).slice(-MAX_SAVED)));
}

/** Restores saved panels, and opens readers as panels while the setting is on. Returns cleanup. */
export function startReaderPanels(client: PanelHost, makeComponent: ReaderComponent, store: Storage | null = typeof localStorage === "undefined" ? null : localStorage): () => void {
  host = client;
  component = makeComponent;
  storage = store;
  const saved = parse(PANELS_KEY);
  const open = store ? openReaderPanels(store) : null;
  for (const [panelId, document] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
    const { path, name } = (document ?? {}) as Partial<ReaderDocument>;
    if (typeof path === "string" && typeof name === "string" && panelId === readerPanelId(path) && (!open || open.has(panelId))) register(panelId, { path, name });
  }
  saveDocuments();
  let release: (() => void) | undefined;
  const acknowledge = (intent: Delivery) => { void client.rpc(ackRpc, { ids: [intent.id], generation: intent.generation }).catch(() => {}); };
  const sync = () => {
    const wanted = getState().readerPanels && isDesktop();
    if (wanted && !release) release = setPanelOpener(openReader, acknowledge);
    if (!wanted && release) { release(); release = undefined; }
  };
  sync();
  const unsubscribe = subscribeState(sync);
  return () => {
    unsubscribe();
    release?.();
    for (const remove of removals.values()) remove();
    for (const map of [documents, removals, pending, waiters, relaunching, mounted]) map.clear();
    host = component = storage = null;
  };
}
