import type { Revision } from "../core/annotation-ledger";

export const PROTOCOL_VERSION = 1 as const;
export const SERVICE_ID = "tether" as const;

export type DiscoveryRecord = {
  protocol: typeof PROTOCOL_VERSION;
  instanceId: string;
  pid: number;
  origin: string;
  startedAt: string;
};

export type HostCapabilities = {
  embeddedBrowser: boolean;
  hiddenNavigation: boolean;
  widgetInstallation: boolean;
  fileNavigatorHook: boolean;
  revealFile: boolean;
};

export type AppPreferences = import("./themes").ThemePreferences;

export type SerializableAnnotationState = {
  header?: { baseBodyRevision?: string; documentId?: string };
  events: unknown[];
  threads: unknown[];
  acknowledgements: unknown[];
  maxSequence: number;
  unresolvedCount: number;
};

export type DocumentSnapshot = {
  path: string;
  body: string;
  content: string;
  bodyRevision: Revision;
  ledgerRevision: Revision;
  revision: Revision;
  annotations: SerializableAnnotationState;
  readOnly?: boolean;
  ledgerError?: string;
};

export type SessionBootstrap = {
  protocol: typeof PROTOCOL_VERSION;
  sessionId: string;
  document: DocumentSnapshot;
  capabilities: HostCapabilities;
  preferences: AppPreferences;
  actor: string;
};

export type ProtocolSuccess<T = unknown> = {
  protocol: typeof PROTOCOL_VERSION;
  ok: true;
  command: string;
  data: T;
};

export type ProtocolFailure = {
  protocol: typeof PROTOCOL_VERSION;
  ok: false;
  command: string;
  error: { code: string; message: string; details?: unknown };
};

export type ProtocolResponse<T = unknown> = ProtocolSuccess<T> | ProtocolFailure;

export type BrowserSessionRoutes = {
  root: string;
  api: string;
};

export function sessionRoutes(sessionId: string): BrowserSessionRoutes {
  const root = `/s/${encodeURIComponent(sessionId)}/`;
  return { root, api: `${root}api` };
}
