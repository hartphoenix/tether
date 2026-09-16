import type { HostCapabilities } from "../shared/contracts";
import type { RecentEntry } from "../recents/registry";
import type { TetherConfig } from "../server/config";
import type { HostAdapter, HostTarget, OpenLocalFileRequest, OpenViewRequest, OpenViewResult } from "./host-adapter";
import { isSupportedCmuxVersion } from "./cmux";
import { openThroughCmuxBridge, openLocalFileThroughCmuxBridge } from "./cmux-bridge";
import { openThroughWaveBridge, updateWaveRecentsThroughBridge } from "./wave-bridge";
import { isSupportedWaveVersion } from "./wave";

const unavailable: HostCapabilities = {
  embeddedBrowser: false,
  hiddenNavigation: false,
  widgetInstallation: false,
  fileNavigatorHook: false,
  revealFile: true,
};

/** Routes daemon callbacks by their immutable launch target. */
export class HostGateway implements HostAdapter {
  readonly id = "browser" as const;

  constructor(private readonly config: TetherConfig, private readonly fallback: HostAdapter) {}

  async detect(): Promise<boolean> { return true; }

  capabilities(target?: HostTarget): HostCapabilities {
    if (target?.host === "wave") return {
      embeddedBrowser: isSupportedWaveVersion(target.version),
      hiddenNavigation: isSupportedWaveVersion(target.version),
      widgetInstallation: isSupportedWaveVersion(target.version),
      fileNavigatorHook: false,
      revealFile: true,
    };
    if (target?.host === "cmux") return {
      ...unavailable,
      embeddedBrowser: isSupportedCmuxVersion(target.version),
    };
    return this.fallback.capabilities(target);
  }

  async openView(request: OpenViewRequest): Promise<OpenViewResult> {
    if (request.target?.host === "wave") {
      await openThroughWaveBridge(this.config, request);
      return { launchConsumed: true };
    }
    if (request.target?.host === "cmux") {
      return openThroughCmuxBridge(this.config, request);
    }
    const result = await this.fallback.openView(request);
    return result ?? { launchConsumed: true };
  }

  async openLocalFile(request: OpenLocalFileRequest): Promise<void> {
    if (request.target?.host === "cmux") return openLocalFileThroughCmuxBridge(this.config, request);
    if (!this.fallback.openLocalFile) throw new Error("Native local-file opening is unavailable in this host.");
    return this.fallback.openLocalFile(request);
  }

  async recentsChanged(entries: RecentEntry[], target?: HostTarget): Promise<boolean> {
    if (target?.host !== "wave") return false;
    await updateWaveRecentsThroughBridge(this.config, entries);
    return true;
  }

  openExternal(pathOrUrl: string): Promise<void> { return this.fallback.openExternal(pathOrUrl); }
  revealFile(path: string): Promise<void> { return this.fallback.revealFile?.(path) ?? Promise.resolve(); }
}

export function waveCapabilitiesUnavailable(): HostCapabilities { return { ...unavailable }; }
