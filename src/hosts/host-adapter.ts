import type { HostCapabilities } from "../shared/contracts";
import type { RecentEntry } from "../recents/registry";

export type HostTarget = Record<string, string>;
export type InstallResult = { installed: boolean; message?: string };
export type OpenViewRequest = {
  url: string;
  kind: "document" | "recents";
  focus: boolean;
  allowFocusedFallback?: boolean;
  targetPolicy?: "focused-workspace" | "source-pane";
  sourceUrl?: string;
  target?: HostTarget;
};
export type OpenLocalFileRequest = { path: string; sourceUrl: string; target?: HostTarget };
export type OpenViewResult = { launchConsumed: boolean };

export interface HostAdapter {
  readonly id: "wave" | "cmux" | "calyx" | "obsidian" | "browser";
  detect(): Promise<boolean>;
  capabilities(target?: HostTarget): HostCapabilities;
  launchTarget?(): HostTarget | undefined;
  openView(request: OpenViewRequest): Promise<OpenViewResult | void>;
  openLocalFile?(request: OpenLocalFileRequest): Promise<void>;
  openExternal(pathOrUrl: string): Promise<void>;
  revealFile?(path: string): Promise<void>;
  recentsChanged?(entries: RecentEntry[], target?: HostTarget): Promise<boolean | void>;
  installLaunchers?(): Promise<InstallResult>;
}
