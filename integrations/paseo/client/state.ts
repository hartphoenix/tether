import { useSyncExternalStore } from "react";
import type { FolioEntry, HubStatus, Intent, Notice } from "../shared/contracts";

export type Opener = (intent: Intent) => void;
export type FolioScope = "project" | "all";

export type TetherState = {
  folio: FolioEntry[] | null;
  notices: Readonly<Record<string, Notice>>;
  buttons: boolean;
  status: HubStatus;
  /** Shared by every Folio panel, so Folio reads the same in every workspace. */
  query: string;
  scope: FolioScope;
};

let state: TetherState = {
  folio: null,
  notices: {},
  buttons: true,
  status: { connected: false, tether: null, error: null },
  query: "",
  scope: "project",
};
const listeners = new Set<() => void>();

export function getState(): TetherState { return state; }

export function setState(patch: Partial<TetherState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function subscribeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTetherState<T>(select: (value: TetherState) => T): T {
  return useSyncExternalStore(subscribeState, () => select(state));
}

// Mounted Folio panels lend their `openBrowser`; the oldest one opens every tab.
const openers = new Set<Opener>();
const waiting: Intent[] = [];

export function hasOpener(): boolean { return openers.size > 0; }

// A re-offered intent (lapsed lease, lost ack) must never open a second tab.
const opened = new Set<string>();

/** Run an intent now if a panel can open it; otherwise hold it for the next panel. */
export function runOrHold(intent: Intent, onOpened: (intent: Intent) => void): boolean {
  if (opened.has(intent.id)) { onOpened(intent); return true; }
  const open = openers.values().next().value;
  if (!open) {
    if (!waiting.some(held => held.id === intent.id)) waiting.push(intent);
    return false;
  }
  opened.add(intent.id);
  if (opened.size > 200) opened.delete(opened.values().next().value!);
  open(intent);
  onOpened(intent);
  return true;
}

export function lendOpener(open: Opener, onOpened: (intent: Intent) => void): () => void {
  openers.add(open);
  for (const intent of waiting.splice(0)) runOrHold(intent, onOpened);
  return () => { openers.delete(open); };
}
