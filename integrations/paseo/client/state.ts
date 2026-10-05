import { useSyncExternalStore } from "react";
import type { Connection, FolioEntry, HubStatus, Intent, Notice, PumpBatch } from "../shared/contracts";
import type { Restore } from "./tab-restore";

export type Delivery = Intent & { generation: string; source: string };
export type Opener = (intent: Delivery) => void;
export type FolioScope = "project" | "all";

export type TetherState = {
  connection: Connection | null;
  folio: FolioEntry[] | null;
  notices: Readonly<Record<string, Notice>>;
  /** Browser tabs offered after a workspace move, by target workspace. */
  restores: Readonly<Record<string, Restore>>;
  buttons: boolean;
  /** Readers open as plugin panels instead of browser tabs. */
  readerPanels: boolean;
  status: HubStatus;
  /** Shared by every Folio panel, so Folio reads the same in every workspace. */
  query: string;
  scope: FolioScope;
};

let state: TetherState = {
  connection: null,
  folio: null,
  notices: {},
  restores: {},
  buttons: true,
  readerPanels: false,
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
const waiting: Delivery[] = [];
// In panel mode, documents open as plugin panels, which need no mounted Folio.
let panelOpener: Opener | null = null;

export function hasOpener(): boolean { return panelOpener !== null || openers.size > 0; }

function openerFor(intent: Delivery): Opener | undefined {
  return (intent.path ? panelOpener : null) ?? openers.values().next().value;
}

// A re-offered intent (lapsed lease, lost ack) must never open a second tab.
const opened = new Set<string>();

/** Run an intent now if a panel can open it; otherwise hold it for the next panel. */
export function runOrHold(intent: Delivery, onOpened: (intent: Delivery) => void): boolean {
  if (intent.generation !== state.connection?.generation || intent.source !== sourceKey()) return true;
  const key = JSON.stringify([intent.source, intent.id]);
  if (opened.has(key)) { onOpened(intent); return true; }
  const open = openerFor(intent);
  if (!open) {
    if (!waiting.some(held => held.id === intent.id)) waiting.push(intent);
    return false;
  }
  open(intent);
  opened.add(key);
  if (opened.size > 200) opened.delete(opened.values().next().value!);
  onOpened(intent);
  return true;
}

export function lendOpener(open: Opener, onOpened: (intent: Delivery) => void): () => void {
  openers.add(open);
  for (const intent of waiting.splice(0)) runOrHold(intent, onOpened);
  return () => { openers.delete(open); };
}

/** Installs the reader-panel opener, which takes every intent that names its document. */
export function setPanelOpener(open: Opener, onOpened: (intent: Delivery) => void): () => void {
  panelOpener = open;
  for (const intent of waiting.splice(0)) runOrHold(intent, onOpened);
  return () => { if (panelOpener === open) panelOpener = null; };
}

/** Stable across connection generations, so returning to a daemon preserves deduplication. */
export function sourceKey(): string {
  return JSON.stringify([state.connection?.tetherPath, state.connection?.profile, state.status.tether]);
}

export function acceptBatch(batch: PumpBatch): void {
  if (state.connection?.generation !== batch.connection?.generation || state.status.tether !== batch.status.tether) waiting.length = 0;
  setState({ connection: batch.connection, folio: batch.folio, notices: batch.notices, buttons: batch.buttons, readerPanels: batch.readerPanels === true, status: batch.status });
}

export function disconnect(): void {
  waiting.length = 0;
  setState({ connection: null, folio: null, notices: {}, status: { connected: false, tether: null, error: "Connection interrupted. Retrying…" } });
}
