import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getState, setState } from "./state";

/**
 * Restores browser tabs after a workspace move. A moved agent carries the
 * `moved-from-workspace` label. The old workspace's tab URLs are read from the
 * app's saved layout, and the new workspace's Tether button offers them. Nothing
 * opens until the user presses that button, and tabs open only in that workspace.
 *
 * The layout keys are Paseo app internals, not plugin API. If Paseo changes
 * them, nothing is offered.
 */
export const MOVED_FROM_LABEL = "moved-from-workspace";
export type Restore = { from: string; urls: string[] };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type UrlOpener = (url: string, workspaceId: string) => void;

const DONE_KEY = "tether.tab-restore.v1";
const openers = new Set<UrlOpener>();
const waiting = new Set<string>();

const parse = (storage: Storage, key: string): any => {
  try { return JSON.parse(storage.getItem(key) ?? "null"); } catch { return null; }
};
const isHttp = (value: unknown): value is string => {
  try { return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};

/** Browser tab URLs saved for a workspace, in pane order. */
export function readWorkspaceTabs(storage: Storage, workspaceId: string): string[] {
  const layouts = parse(storage, "workspace-layout-state")?.state?.layoutByWorkspace ?? {};
  const key = Object.keys(layouts).find(name => name.endsWith(`:${workspaceId}`));
  const browsers = parse(storage, "workspace-browser-store")?.state?.browsersById ?? {};
  const ids: string[] = [];
  const walk = (node: any): void => {
    if (node?.kind === "group") for (const child of node.group?.children ?? []) walk(child);
    if (node?.kind === "pane") for (const tab of node.pane?.tabs ?? []) if (tab?.target?.kind === "browser") ids.push(tab.target.browserId);
  };
  if (key) walk(layouts[key].root);
  return [...new Set(ids.map(id => browsers[id]?.url).filter(isHttp))];
}

const doneKeys = (storage: Storage): string[] => {
  const value = parse(storage, DONE_KEY);
  return Array.isArray(value) ? value : [];
};
const doneKey = (to: string, from: string) => `${to}<${from}`;

/** Pending restores by target workspace, from agents' labels. */
export function findRestores(storage: Storage, agents: { workspaceId?: string | null; labels?: Record<string, string> }[]): Record<string, Restore> {
  const done = new Set(doneKeys(storage));
  const restores: Record<string, Restore> = {};
  for (const agent of agents) {
    const from = agent.labels?.[MOVED_FROM_LABEL];
    const to = agent.workspaceId;
    if (!from || !to || from === to || restores[to] || done.has(doneKey(to, from))) continue;
    const urls = readWorkspaceTabs(storage, from);
    if (urls.length) restores[to] = { from, urls };
  }
  return restores;
}

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

const run = (workspaceId: string): boolean => {
  const restore = getState().restores[workspaceId];
  const open = openers.values().next().value;
  const store = storage();
  if (!restore) return true;
  if (!open || !store) return false;
  for (const url of restore.urls) open(url, workspaceId);
  store.setItem(DONE_KEY, JSON.stringify([...doneKeys(store), doneKey(workspaceId, restore.from)].slice(-100)));
  const { [workspaceId]: _, ...rest } = getState().restores;
  setState({ restores: rest });
  return true;
};

/** Open a workspace's queued tabs, or hold them until a Folio panel can open them. */
export function restoreTabs(workspaceId: string): boolean {
  if (run(workspaceId)) return true;
  waiting.add(workspaceId);
  return false;
}

/** Mounted Folio panels lend Paseo's `openBrowser` for restores. */
export function lendUrlOpener(open: UrlOpener): () => void {
  openers.add(open);
  for (const workspaceId of [...waiting]) { waiting.delete(workspaceId); run(workspaceId); }
  return () => { openers.delete(open); };
}

/** Watches agents for move labels and keeps `restores` current. Returns cleanup. */
export function startTabRestore(client: PluginClientContext): () => void {
  let stopped = false;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = async () => {
    const store = storage();
    if (stopped || !store) return;
    try {
      const { entries } = await client.paseo.agents.list();
      if (!stopped) setState({ restores: findRestores(store, entries.map(entry => entry.agent)) });
    } catch {}
  };
  // Agent updates arrive often while agents run; reread at most once a second.
  const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 1_000); };
  void client.paseo.agents
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) { void subscription.release(); return; }
      release = () => { void subscription.release(); };
      subscription.subscribe({ snapshot: refresh, update: refresh });
    })
    .catch(refresh);
  return () => { stopped = true; clearTimeout(timer); release?.(); };
}
