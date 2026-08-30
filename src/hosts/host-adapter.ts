import type { HostCapabilities } from "../shared/contracts";

export type HostTarget = Record<string, string>;
export type InstallResult = { installed: boolean; message?: string };

export interface HostAdapter {
  readonly id: "wave" | "cmux" | "calyx" | "obsidian" | "browser";
  detect(): Promise<boolean>;
  capabilities(): HostCapabilities;
  openView(url: string, target?: HostTarget): Promise<void>;
  openExternal(pathOrUrl: string): Promise<void>;
  revealFile?(path: string): Promise<void>;
  installLaunchers?(): Promise<InstallResult>;
}
