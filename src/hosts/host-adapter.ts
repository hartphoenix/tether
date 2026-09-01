import type { HostCapabilities } from "../shared/contracts";
import type { RecentEntry } from "../recents/registry";

export type HostTarget = Record<string, string>;
export type InstallResult = { installed: boolean; message?: string };

export interface HostAdapter {
  readonly id: "wave" | "cmux" | "calyx" | "obsidian" | "browser";
  detect(): Promise<boolean>;
  capabilities(target?: HostTarget): HostCapabilities;
  launchTarget?(): HostTarget | undefined;
  openView(url: string, target?: HostTarget): Promise<void>;
  openExternal(pathOrUrl: string): Promise<void>;
  revealFile?(path: string): Promise<void>;
  recentsChanged?(entries: RecentEntry[], target?: HostTarget): Promise<void>;
  installLaunchers?(): Promise<InstallResult>;
}
