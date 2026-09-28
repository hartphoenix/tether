import type { HostCapabilities } from "../shared/contracts";
import type { HostAdapter, HostTarget, OpenViewRequest, OpenViewResult } from "./host-adapter";
import type { PullIntentInput, PullOrigin } from "./pull-queue";
import { createBrowserHost } from "./browser";

export const PASEO_HOST = "paseo";

/** Sends an intent to the daemon's pull queue: directly in the daemon, over control in the CLI. */
export type PullSink = (intent: PullIntentInput) => Promise<unknown>;
export type PaseoHostOptions = { enqueue: PullSink; env?: NodeJS.ProcessEnv; origin?: PullOrigin; fallback?: HostAdapter };

/** The Paseo launch context carried in the environment, innermost first. */
export function paseoLaunchTarget(env: NodeJS.ProcessEnv = process.env): HostTarget | undefined {
  const workspaceId = env.TETHER_PASEO_WORKSPACE_ID?.trim();
  if (workspaceId) return { host: PASEO_HOST, workspaceId };
  const terminalId = env.PASEO_TERMINAL_ID?.trim();
  if (terminalId) return { host: PASEO_HOST, terminalId };
  return undefined;
}

/**
 * Paseo cannot be driven from outside, so this adapter never opens anything
 * itself: it queues an intent that the Tether plugin inside Paseo pulls and
 * carries out. Opens made by the plugin on the user's behalf are `user`
 * intents; any other CLI open (an agent's) only notifies, so a host never
 * moves the user's focus unasked.
 */
export class PaseoHostAdapter implements HostAdapter {
  readonly id = "paseo" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallback: HostAdapter;

  constructor(private readonly options: PaseoHostOptions) {
    this.env = options.env ?? process.env;
    this.fallback = options.fallback ?? createBrowserHost();
  }

  async detect(): Promise<boolean> { return paseoLaunchTarget(this.env) !== undefined; }

  launchTarget(): HostTarget | undefined { return paseoLaunchTarget(this.env); }

  capabilities(): HostCapabilities {
    return { embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: process.platform === "darwin" };
  }

  private origin(): PullOrigin {
    return this.options.origin ?? (this.env.TETHER_PASEO_ORIGIN === "user" ? "user" : "agent");
  }

  async openView(request: OpenViewRequest): Promise<OpenViewResult> {
    const origin = this.origin();
    const target = request.target ?? this.launchTarget();
    await this.options.enqueue({
      url: request.url,
      kind: request.kind,
      origin,
      ...(request.path ? { path: request.path } : {}),
      ...(target ? { target } : {}),
      ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
    });
    // A notification leaves its ticket unused; the plugin reopens by path when the user chooses.
    return origin === "user" ? { launchConsumed: true } : { launchConsumed: false, notified: true };
  }

  openExternal(pathOrUrl: string): Promise<void> { return this.fallback.openExternal(pathOrUrl); }
  revealFile(path: string): Promise<void> { return this.fallback.revealFile?.(path) ?? Promise.resolve(); }
}
