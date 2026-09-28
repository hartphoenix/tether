import type { HostCapabilities } from "../shared/contracts";
import type { RecentEntry } from "../recents/registry";
import type { RecoveryReport, RecoveryView } from "./recovery";

export type HostTarget = Record<string, string>;
export type InstallResult = { installed: boolean; message?: string };
export type OpenViewRequest = {
  url: string;
  /** Canonical document path, when the view is a document. */
  path?: string;
  kind: "document" | "recents";
  focus: boolean;
  allowFocusedFallback?: boolean;
  targetPolicy?: "focused-workspace" | "source-pane";
  sourceUrl?: string;
  target?: HostTarget;
};
export type OpenLocalFileRequest = { path: string; sourceUrl: string; target?: HostTarget };
/** `launchConsumed:false` releases the ticket; `notified` means the host only announced the document. */
export type OpenViewResult = { launchConsumed: boolean; notified?: boolean };

export interface HostAdapter {
  readonly id: "wave" | "cmux" | "calyx" | "obsidian" | "browser" | "paseo";
  detect(): Promise<boolean>;
  capabilities(target?: HostTarget): HostCapabilities;
  launchTarget?(): HostTarget | undefined;
  openView(request: OpenViewRequest): Promise<OpenViewResult | void>;
  openLocalFile?(request: OpenLocalFileRequest): Promise<void>;
  openExternal(pathOrUrl: string): Promise<void>;
  revealFile?(path: string): Promise<void>;
  recentsChanged?(entries: RecentEntry[], target?: HostTarget): Promise<boolean | void>;
  /** Tell the user about a document without opening it; true when the host took the announcement. */
  announce?(path: string, target?: HostTarget): Promise<boolean>;
  installLaunchers?(): Promise<InstallResult>;
  recoverViews?(views: RecoveryView[], inspect?: boolean): Promise<RecoveryReport>;
}
