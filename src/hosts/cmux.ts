import { createBrowserHost, type BrowserHostAdapter } from "./browser";
import type { HostAdapter, HostTarget, OpenViewRequest } from "./host-adapter";
import { PROTOCOL_VERSION, SERVICE_ID, type HostCapabilities } from "../shared/contracts";

export const SUPPORTED_CMUX_VERSION = "0.64.22";
export const SUPPORTED_CMUX_BUILD = 102;
export const SUPPORTED_CMUX_COMMIT = "ddd4a01bc";
// Retained only to rediscover review panes created before document-derived titles.
export const TETHER_REVIEW_TAB_TITLE = "Tether Review";
export const TETHER_RECENTS_TAB_TITLE = "Recents";

export type CmuxCommandResult = { exitCode: number; stdout: string; stderr: string };
export type CmuxCommandRunner = (command: string[], env: NodeJS.ProcessEnv) => Promise<CmuxCommandResult>;
export type CmuxErrorCode =
  | "cmux_not_detected"
  | "unsupported_version"
  | "socket_unavailable"
  | "socket_unauthorized"
  | "invalid_response"
  | "invalid_target"
  | "target_missing"
  | "placement_anchor_missing"
  | "ambiguous_review_pane"
  | "dock_unavailable"
  | "ambiguous_recents_surface"
  | "command_failed";

export class CmuxHostError extends Error {
  readonly name = "CmuxHostError";
  constructor(readonly code: CmuxErrorCode, message: string, readonly causeText?: string) {
    super(message);
  }
}

export type CmuxHostOptions = {
  env?: NodeJS.ProcessEnv;
  run?: CmuxCommandRunner;
  cmuxPath?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  externalHost?: Pick<BrowserHostAdapter, "openExternal" | "revealFile">;
};

type CmuxSurface = { id?: unknown; type?: unknown; title?: unknown; url?: unknown; active?: unknown; selected?: unknown };
type CmuxPane = { id?: unknown; dock_scope?: unknown; active?: unknown; selected_surface_id?: unknown; surfaces?: unknown };
type CmuxWorkspace = { id?: unknown; panes?: unknown };
type CmuxWindow = { id?: unknown; workspaces?: unknown };
type CmuxTree = { windows?: unknown };
type CmuxIdentity = {
  caller?: unknown;
  focused?: unknown;
};
type CmuxBuild = { version: string; build: number | null; commit: string | null };
export type CmuxOpenResult = { launchConsumed: boolean };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const unavailableCapabilities: HostCapabilities = {
  embeddedBrowser: false,
  hiddenNavigation: false,
  widgetInstallation: false,
  fileNavigatorHook: false,
  revealFile: true,
};

const availableCapabilities: HostCapabilities = {
  embeddedBrowser: true,
  hiddenNavigation: false,
  widgetInstallation: false,
  fileNavigatorHook: false,
  revealFile: true,
};

function cmuxEnvironment(source: NodeJS.ProcessEnv, target?: HostTarget): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "TMPDIR", "LANG", "LC_ALL",
    "CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID",
  ];
  const env = Object.fromEntries(allowed.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]!]]));
  if (target?.workspaceId) env.CMUX_WORKSPACE_ID = target.workspaceId;
  if (target?.surfaceId) env.CMUX_SURFACE_ID = target.surfaceId;
  return env;
}

async function runCmuxCommand(command: string[], env: NodeJS.ProcessEnv): Promise<CmuxCommandResult> {
  const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function parseBuild(output: string): CmuxBuild | null {
  const match = /(?:^|\s)cmux\s+v?(\d+\.\d+\.\d+)(?:\s+\((\d+)\))?(?:\s+\[([0-9a-f]+)\])?(?:\s|$)/i.exec(output);
  if (!match) return null;
  return { version: match[1]!, build: match[2] ? Number(match[2]) : null, commit: match[3]?.toLowerCase() ?? null };
}

function supportedBuild(build: CmuxBuild | null): boolean {
  return build?.version === SUPPORTED_CMUX_VERSION && build.build === SUPPORTED_CMUX_BUILD && build.commit === SUPPORTED_CMUX_COMMIT;
}

function stringField(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function workspaceFromTree(tree: CmuxTree, workspaceId: string): CmuxWorkspace | undefined {
  return asArray<CmuxWindow>(tree.windows)
    .flatMap((window) => asArray<CmuxWorkspace>(window.workspaces))
    .find((workspace) => workspace.id === workspaceId);
}

function panes(workspace: CmuxWorkspace): CmuxPane[] {
  return asArray<CmuxPane>(workspace.panes);
}

function surfaces(pane: CmuxPane): CmuxSurface[] {
  return asArray<CmuxSurface>(pane.surfaces);
}

function safeLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function liveRecentsUrl(raw: unknown, launchUrl: string, daemonInstanceId: string): boolean {
  if (typeof raw !== "string") return false;
  try {
    const current = new URL(raw);
    return current.origin === new URL(launchUrl).origin && /^\/r\/[^/]+\/$/.test(current.pathname) &&
      current.searchParams.size === 1 && current.searchParams.get("instance") === daemonInstanceId && !current.hash;
  } catch { return false; }
}

function tetherRecentsUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !safeLoopbackUrl(raw)) return false;
  try {
    const url = new URL(raw);
    return /^\/r\/[^/]+\/$/.test(url.pathname) && url.searchParams.has("instance") && !url.hash;
  } catch { return false; }
}

function liveTetherDocumentUrl(raw: unknown, launchUrl: string): boolean {
  if (typeof raw !== "string") return false;
  try {
    const current = new URL(raw);
    return current.origin === new URL(launchUrl).origin && /^\/s\/[^/]+\/$/.test(current.pathname) && !current.hash;
  } catch { return false; }
}

function failureCode(result: CmuxCommandResult): CmuxErrorCode {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (output.includes("dock placement is disabled") || output.includes("mode 'dock' is not available")) return "dock_unavailable";
  if (output.includes("operation not permitted") || output.includes("unauthorized") || output.includes("forbidden")) return "socket_unauthorized";
  if (output.includes("failed to connect") || output.includes("socket") && output.includes("not found")) return "socket_unavailable";
  if ((output.includes("workspace") || output.includes("window")) && output.includes("not found")) return "target_missing";
  if (output.includes("surface not found") || output.includes("no source surface")) return "placement_anchor_missing";
  return "command_failed";
}

function failureMessage(code: CmuxErrorCode, result: CmuxCommandResult): string {
  if (code === "dock_unavailable") return "The cmux Dock is unavailable. Enable the right-sidebar Dock beta feature, then retry.";
  if (code === "socket_unauthorized") return "cmux rejected socket access from this process.";
  if (code === "socket_unavailable") return "The cmux control socket is unavailable.";
  if (code === "target_missing") return "The originating cmux workspace is no longer available.";
  if (code === "placement_anchor_missing") return "The originating cmux surface is no longer available.";
  return result.stderr || result.stdout || `cmux exited with status ${result.exitCode}`;
}

function requireUuid(value: string | undefined, field: string): string {
  if (!value || !uuidPattern.test(value)) throw new CmuxHostError("invalid_target", `A valid cmux ${field} is required.`);
  return value;
}

function requireResponseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new CmuxHostError("invalid_response", `cmux returned an invalid ${field}.`);
  }
  return value;
}

/** cmux 0.64.22 adapter using only structured CLI/socket responses. */
export class CmuxHostAdapter implements HostAdapter {
  readonly id = "cmux" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: CmuxCommandRunner;
  private readonly cmuxPath: string;
  private readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly externalHost: Pick<BrowserHostAdapter, "openExternal" | "revealFile">;
  private build: CmuxBuild | null = null;
  private capturedTarget: HostTarget | undefined;
  private readonly placementQueues = new Map<string, Promise<void>>();

  constructor(options: CmuxHostOptions = {}) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCmuxCommand;
    this.cmuxPath = options.cmuxPath ?? this.env.CMUX_BUNDLED_CLI_PATH ?? Bun.which("cmux") ?? "/Applications/cmux.app/Contents/Resources/bin/cmux";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.externalHost = options.externalHost ?? createBrowserHost();
  }

  async detect(): Promise<boolean> {
    if (!this.env.CMUX_WORKSPACE_ID || !this.env.CMUX_SURFACE_ID || !this.env.CMUX_SOCKET_PATH) return false;
    let result: CmuxCommandResult;
    try { result = await this.run([this.cmuxPath, "--version"], cmuxEnvironment(this.env)); }
    catch {
      this.build = null;
      this.capturedTarget = undefined;
      return false;
    }
    this.build = result.exitCode === 0 ? parseBuild(`${result.stdout} ${result.stderr}`) : null;
    if (!this.build) return false;
    try { this.capturedTarget = await this.captureTarget(); }
    catch { this.capturedTarget = undefined; }
    return true;
  }

  capabilities(): HostCapabilities {
    return supportedBuild(this.build) ? { ...availableCapabilities } : { ...unavailableCapabilities };
  }

  detectedVersion(): string | null { return this.build?.version ?? null; }
  detectedBuild(): number | null { return this.build?.build ?? null; }
  detectedCommit(): string | null { return this.build?.commit ?? null; }

  launchTarget(): HostTarget | undefined {
    return this.capturedTarget ? { ...this.capturedTarget } : undefined;
  }

  async captureTarget(): Promise<HostTarget> {
    if (!supportedBuild(this.build)) {
      throw new CmuxHostError("unsupported_version", this.unsupportedBuildMessage());
    }
    const identity = await this.runJson<CmuxIdentity>([
      "--json", "--id-format", "uuids", "identify",
      "--workspace", this.env.CMUX_WORKSPACE_ID!, "--surface", this.env.CMUX_SURFACE_ID!,
    ]);
    const caller = identity.caller;
    const windowId = requireUuid(stringField(caller, "window_id"), "window ID");
    const workspaceId = requireUuid(stringField(caller, "workspace_id"), "workspace ID");
    const surfaceId = requireUuid(stringField(caller, "surface_id"), "surface ID");
    return {
      host: "cmux", version: SUPPORTED_CMUX_VERSION,
      build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT,
      windowId, workspaceId, surfaceId,
    };
  }

  async probeSocket(): Promise<void> {
    let result: CmuxCommandResult;
    try { result = await this.run([this.cmuxPath, "ping"], cmuxEnvironment(this.env, this.capturedTarget)); }
    catch (error) {
      throw new CmuxHostError("cmux_not_detected", "The cmux executable could not be started.", error instanceof Error ? error.message : String(error));
    }
    if (result.exitCode !== 0) this.throwCommandFailure(result);
  }

  async openView(request: OpenViewRequest): Promise<CmuxOpenResult> {
    if (!supportedBuild(this.build)) {
      throw new CmuxHostError("unsupported_version", this.unsupportedBuildMessage());
    }
    if (!safeLoopbackUrl(request.url)) throw new CmuxHostError("invalid_target", "cmux placement accepts only loopback Tether URLs.");
    const target = this.validatedTarget(request.target ?? this.capturedTarget);
    if (request.kind === "recents") return this.serialized(target.workspaceId, () => this.openRecents(request, target));
    if (request.targetPolicy === "focused-workspace") {
      const effectiveTarget = await this.resolveFocusedDocumentTarget();
      return this.serialized(effectiveTarget.workspaceId, async () => {
        await this.openDocument(request, effectiveTarget, true);
        return { launchConsumed: true };
      });
    }
    return this.serialized(target.workspaceId, async () => {
      const effectiveTarget = await this.resolveCapturedDocumentTarget(request, target);
      const place = async (): Promise<CmuxOpenResult> => {
        await this.openDocument(request, effectiveTarget);
        return { launchConsumed: true };
      };
      return effectiveTarget.workspaceId === target.workspaceId ? place() : this.serialized(effectiveTarget.workspaceId, place);
    });
  }

  async openExternal(pathOrUrl: string): Promise<void> {
    await this.externalHost.openExternal(pathOrUrl);
  }

  async revealFile(path: string): Promise<void> {
    await this.externalHost.revealFile(path);
  }

  private validatedTarget(target: HostTarget | undefined): HostTarget & { windowId: string; workspaceId: string; surfaceId: string } {
    if (!target || target.host !== "cmux") throw new CmuxHostError("invalid_target", "A captured cmux launch target is required.");
    if (target.version !== SUPPORTED_CMUX_VERSION || target.build !== String(SUPPORTED_CMUX_BUILD) || target.commit !== SUPPORTED_CMUX_COMMIT) {
      throw new CmuxHostError("unsupported_version", `Tether supports cmux ${SUPPORTED_CMUX_VERSION} build ${SUPPORTED_CMUX_BUILD} commit ${SUPPORTED_CMUX_COMMIT}; the target reports a different build.`);
    }
    return {
      ...target,
      windowId: requireUuid(target.windowId, "window ID"),
      workspaceId: requireUuid(target.workspaceId, "workspace ID"),
      surfaceId: requireUuid(target.surfaceId, "surface ID"),
    };
  }

  private unsupportedBuildMessage(): string {
    const detected = this.build
      ? `${this.build.version} build ${this.build.build ?? "unknown"} commit ${this.build.commit ?? "unknown"}`
      : "no compatible version";
    return `Tether supports cmux ${SUPPORTED_CMUX_VERSION} build ${SUPPORTED_CMUX_BUILD} commit ${SUPPORTED_CMUX_COMMIT}; detected ${detected}.`;
  }

  private async serialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.placementQueues.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.placementQueues.set(workspaceId, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.placementQueues.get(workspaceId) === queued) this.placementQueues.delete(workspaceId);
    }
  }

  private async openDocument(
    request: OpenViewRequest,
    target: HostTarget & { windowId: string; workspaceId: string; surfaceId: string },
    splitFromAnchor = false,
  ): Promise<void> {
    const tree = await this.tree(target);
    const workspace = workspaceFromTree(tree, target.workspaceId);
    if (!workspace || !this.workspaceHasSurface(workspace, target.surfaceId)) {
      throw new CmuxHostError("placement_anchor_missing", "The cmux placement anchor is no longer available.");
    }
    const reviewPanes = panes(workspace).filter((pane) => pane.dock_scope === undefined && surfaces(pane).some((surface) =>
      surface.type === "browser" && (surface.title === TETHER_REVIEW_TAB_TITLE || liveTetherDocumentUrl(surface.url, request.url))));
    if (reviewPanes.length > 1) throw new CmuxHostError("ambiguous_review_pane", "Multiple Tether review panes were found in the target workspace.");

    if (reviewPanes.length === 1) {
      const paneId = requireUuid(stringField(reviewPanes[0], "id"), "pane ID");
      await this.openChromelessReviewSurface(request, target, paneId);
      return;
    }

    const anchorPane = panes(workspace).find((pane) => surfaces(pane).some((surface) => surface.id === target.surfaceId));
    const anchorPaneId = requireUuid(stringField(anchorPane, "id"), "anchor pane ID");
    await this.openChromelessReviewSurface(request, target, undefined, splitFromAnchor ? anchorPaneId : undefined);
  }

  private async openChromelessReviewSurface(
    request: OpenViewRequest,
    target: HostTarget & { windowId: string; workspaceId: string; surfaceId: string },
    reviewPaneId?: string,
    splitAnchorPaneId?: string,
  ): Promise<void> {
    const params = JSON.stringify({
      window_id: target.windowId,
      workspace_id: target.workspaceId,
      surface_id: target.surfaceId,
      focus: false,
      show_omnibar: false,
    });
    const created = await this.runJson<Record<string, unknown>>([
      "--json", "--id-format", "both", "rpc", "browser.open_split", params,
    ], target);
    const surfaceId = requireResponseUuid(created.surface_id, "surface ID");
    try {
      if (created.show_omnibar !== false || typeof created.created_split !== "boolean") {
        throw new CmuxHostError("invalid_response", "cmux did not confirm chromeless browser placement.");
      }
      const targetPaneId = requireResponseUuid(created.target_pane_id, "target pane ID");
      if (reviewPaneId && targetPaneId !== reviewPaneId) {
        const moved = await this.moveSurface(surfaceId, reviewPaneId, target);
        this.validatePlacementResult(moved, surfaceId, target, reviewPaneId);
      } else if (!reviewPaneId && !created.created_split) {
        if (splitAnchorPaneId && targetPaneId !== splitAnchorPaneId) {
          const moved = await this.moveSurface(surfaceId, splitAnchorPaneId, target);
          this.validatePlacementResult(moved, surfaceId, target, splitAnchorPaneId);
        }
        const split = await this.splitOffSurface(surfaceId, target);
        this.validatePlacementResult(split, surfaceId, target);
      }
      // cmux treats a focused about:blank surface as a new tab and forcibly
      // reveals its omnibar. Consume the launch URL before focusing so the
      // hidden-chrome creation state survives foreground activation.
      await this.navigateSurface(surfaceId, request.url, target);
      if (request.focus) {
        await this.focusSurface(surfaceId, target);
      }
    }
    catch (cause) {
      try { await this.closeSurface(surfaceId, target); }
      catch { /* preserve the placement or initialization failure after best-effort compensation */ }
      throw cause;
    }
  }

  private workspaceHasSurface(workspace: CmuxWorkspace, surfaceId: string): boolean {
    return panes(workspace).some((pane) => surfaces(pane).some((surface) => surface.id === surfaceId));
  }

  private async resolveCapturedDocumentTarget(
    request: OpenViewRequest,
    target: HostTarget & { windowId: string; workspaceId: string; surfaceId: string },
  ): Promise<HostTarget & { windowId: string; workspaceId: string; surfaceId: string }> {
    try {
      const workspace = workspaceFromTree(await this.tree(target), target.workspaceId);
      if (workspace && this.workspaceHasSurface(workspace, target.surfaceId)) return target;
    } catch (cause) {
      if (!(cause instanceof CmuxHostError) || cause.code !== "target_missing") throw cause;
    }
    if (!request.allowFocusedFallback) {
      throw new CmuxHostError("placement_anchor_missing", "The originating cmux surface is no longer available.");
    }
    const identity = await this.runJson<CmuxIdentity>(["--json", "--id-format", "uuids", "identify", "--no-caller"], undefined, true);
    const focused = identity.focused;
    return {
      host: "cmux",
      version: SUPPORTED_CMUX_VERSION,
      build: String(SUPPORTED_CMUX_BUILD),
      commit: SUPPORTED_CMUX_COMMIT,
      windowId: requireUuid(stringField(focused, "window_id"), "focused window ID"),
      workspaceId: requireUuid(stringField(focused, "workspace_id"), "focused workspace ID"),
      surfaceId: requireUuid(stringField(focused, "surface_id"), "focused surface ID"),
    };
  }

  private async resolveFocusedDocumentTarget(): Promise<HostTarget & { windowId: string; workspaceId: string; surfaceId: string }> {
    const identity = await this.runJson<CmuxIdentity>(["--json", "--id-format", "uuids", "identify", "--no-caller"], undefined, true);
    const focused = identity.focused;
    const windowId = requireUuid(stringField(focused, "window_id"), "focused window ID");
    const workspaceId = requireUuid(stringField(focused, "workspace_id"), "focused workspace ID");
    const focusedSurfaceId = requireUuid(stringField(focused, "surface_id"), "focused surface ID");
    const target = {
      host: "cmux",
      version: SUPPORTED_CMUX_VERSION,
      build: String(SUPPORTED_CMUX_BUILD),
      commit: SUPPORTED_CMUX_COMMIT,
      windowId,
      workspaceId,
      surfaceId: focusedSurfaceId,
    };
    const workspace = workspaceFromTree(await this.tree(target), workspaceId);
    if (!workspace) throw new CmuxHostError("target_missing", "The focused cmux workspace is no longer available.");
    const mainPanes = panes(workspace).filter((pane) => pane.dock_scope === undefined);
    const focusedMainPane = mainPanes.find((pane) => surfaces(pane).some((surface) => surface.id === focusedSurfaceId));
    const activeMainPanes = mainPanes.filter((pane) => pane.active === true);
    const anchorPane = focusedMainPane ?? (activeMainPanes.length === 1 ? activeMainPanes[0] : undefined) ?? (mainPanes.length === 1 ? mainPanes[0] : undefined);
    if (!anchorPane) throw new CmuxHostError("placement_anchor_missing", "The focused cmux workspace has no unambiguous active main pane.");
    const paneSurfaces = surfaces(anchorPane);
    const selectedSurfaceId = stringField(anchorPane, "selected_surface_id");
    const anchorSurface = paneSurfaces.find((surface) => surface.id === selectedSurfaceId)
      ?? paneSurfaces.find((surface) => surface.active === true || surface.selected === true)
      ?? (paneSurfaces.length === 1 ? paneSurfaces[0] : undefined);
    return { ...target, surfaceId: requireUuid(stringField(anchorSurface, "id"), "active main surface ID") };
  }

  private async openRecents(request: OpenViewRequest, target: HostTarget & { windowId: string; workspaceId: string; surfaceId: string }): Promise<CmuxOpenResult> {
    const daemonInstanceId = await this.daemonInstance(request.url);
    const workspace = workspaceFromTree(await this.tree(target), target.workspaceId);
    if (!workspace) throw new CmuxHostError("target_missing", "The originating cmux workspace is no longer available.");
    const candidates = panes(workspace)
      .filter((pane) => pane.dock_scope === "workspace" || pane.dock_scope === "global")
      .flatMap((pane) => surfaces(pane))
      .filter((surface) => surface.type === "browser" && (surface.title === TETHER_RECENTS_TAB_TITLE || tetherRecentsUrl(surface.url)));
    const liveMatches = candidates.filter((surface) => liveRecentsUrl(surface.url, request.url, daemonInstanceId));
    const matches = liveMatches.length === 1 ? liveMatches : candidates;
    if (matches.length > 1) throw new CmuxHostError("ambiguous_recents_surface", "Multiple Tether Recents surfaces were found in the cmux Dock.");

    let surfaceId: string;
    let launchConsumed = true;
    if (matches.length === 1) {
      surfaceId = requireUuid(stringField(matches[0], "id"), "Dock surface ID");
      if (liveRecentsUrl(matches[0]?.url, request.url, daemonInstanceId)) launchConsumed = false;
      else await this.navigateSurface(surfaceId, request.url, target);
    } else {
      const created = await this.runJson<Record<string, unknown>>([
        "--json", "--id-format", "both", "new-surface", "--type", "browser", "--placement", "dock",
        "--workspace", target.workspaceId, "--window", target.windowId, "--focus", "false",
      ], target);
      surfaceId = requireUuid(stringField(created, "dock_surface_id"), "Dock surface ID");
      await this.initializeCreatedDockSurface(surfaceId, request.url, target);
    }

    if (request.focus) {
      await this.runVoid(["--json", "--id-format", "both", "right-sidebar", "set", "dock", "--workspace", target.workspaceId, "--window", target.windowId, "--no-focus"], target);
      await this.runJson(["--json", "--id-format", "both", "focus-panel", "--panel", surfaceId, "--workspace", target.workspaceId, "--window", target.windowId], target);
    }
    return { launchConsumed };
  }

  private async initializeCreatedDockSurface(surfaceId: string, url: string, target: HostTarget & { windowId: string; workspaceId: string }): Promise<void> {
    try { await this.navigateSurface(surfaceId, url, target); }
    catch (cause) {
      try { await this.closeSurface(surfaceId, target); }
      catch { /* preserve the navigation failure after best-effort compensation */ }
      throw cause;
    }
  }

  private navigateSurface(surfaceId: string, url: string, target: HostTarget): Promise<Record<string, unknown>> {
    return this.runJson(["--json", "--id-format", "both", "browser", "--surface", surfaceId, "navigate", url], target);
  }

  private moveSurface(surfaceId: string, paneId: string, target: HostTarget & { windowId: string; workspaceId: string }): Promise<Record<string, unknown>> {
    return this.runJson([
      "--json", "--id-format", "both", "move-surface", "--surface", surfaceId,
      "--pane", paneId, "--workspace", target.workspaceId, "--window", target.windowId,
      "--focus", "false",
    ], target);
  }

  private splitOffSurface(surfaceId: string, target: HostTarget & { windowId: string; workspaceId: string }): Promise<Record<string, unknown>> {
    return this.runJson([
      "--json", "--id-format", "both", "split-off", "--surface", surfaceId, "right",
      "--workspace", target.workspaceId, "--window", target.windowId, "--focus", "false",
    ], target);
  }

  private validatePlacementResult(
    result: Record<string, unknown>,
    surfaceId: string,
    target: HostTarget & { windowId: string; workspaceId: string },
    expectedPaneId?: string,
  ): void {
    const windowId = requireResponseUuid(result.window_id, "placed window ID");
    const workspaceId = requireResponseUuid(result.workspace_id, "placed workspace ID");
    const movedSurfaceId = requireResponseUuid(result.surface_id, "placed surface ID");
    const paneId = requireResponseUuid(result.pane_id, "placed pane ID");
    if (windowId !== target.windowId || workspaceId !== target.workspaceId || movedSurfaceId !== surfaceId || (expectedPaneId && paneId !== expectedPaneId)) {
      throw new CmuxHostError("invalid_response", "cmux returned mismatched browser placement handles.");
    }
  }

  private focusSurface(surfaceId: string, target: HostTarget & { windowId: string; workspaceId: string }): Promise<Record<string, unknown>> {
    return this.runJson([
      "--json", "--id-format", "both", "focus-panel", "--panel", surfaceId,
      "--workspace", target.workspaceId, "--window", target.windowId,
    ], target);
  }

  private closeSurface(surfaceId: string, target: HostTarget & { windowId: string; workspaceId: string }): Promise<Record<string, unknown>> {
    return this.runJson(["--json", "--id-format", "both", "close-surface", "--surface", surfaceId, "--workspace", target.workspaceId, "--window", target.windowId], target);
  }

  private async daemonInstance(launchUrl: string): Promise<string> {
    const health = new URL("/health", launchUrl);
    try {
      const response = await this.fetch(health.toString(), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      const value = await response.json() as { service?: unknown; protocol?: unknown; instanceId?: unknown };
      if (value.service !== SERVICE_ID || value.protocol !== PROTOCOL_VERSION || typeof value.instanceId !== "string" || !value.instanceId || value.instanceId.includes("]")) {
        throw new Error("invalid health response");
      }
      return value.instanceId;
    } catch (cause) {
      throw new CmuxHostError("invalid_response", "The Tether daemon could not validate the retained Recents session.", cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async tree(target: HostTarget & { windowId: string; workspaceId: string }): Promise<CmuxTree> {
    return this.runJson<CmuxTree>([
      "--json", "--id-format", "uuids", "tree", "--workspace", target.workspaceId, "--window", target.windowId,
    ], target);
  }

  private async runJson<T = Record<string, unknown>>(args: string[], target?: HostTarget, omitContext = false): Promise<T> {
    const result = await this.runCommand(args, target, omitContext);
    try {
      const parsed = JSON.parse(result.stdout) as T;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return parsed;
    } catch {
      throw new CmuxHostError("invalid_response", "cmux returned an invalid structured response.");
    }
  }

  private async runVoid(args: string[], target?: HostTarget, omitContext = false): Promise<void> {
    await this.runCommand(args, target, omitContext);
  }

  private async runCommand(args: string[], target?: HostTarget, omitContext = false): Promise<CmuxCommandResult> {
    let result: CmuxCommandResult;
    const environment = cmuxEnvironment(this.env, target);
    if (omitContext) {
      delete environment.CMUX_WORKSPACE_ID;
      delete environment.CMUX_SURFACE_ID;
    }
    try { result = await this.run([this.cmuxPath, ...args], environment); }
    catch (error) {
      throw new CmuxHostError("cmux_not_detected", "The cmux executable could not be started.", error instanceof Error ? error.message : String(error));
    }
    if (result.exitCode !== 0) this.throwCommandFailure(result);
    return result;
  }

  private throwCommandFailure(result: CmuxCommandResult): never {
    const code = failureCode(result);
    throw new CmuxHostError(code, failureMessage(code, result), result.stderr || result.stdout);
  }
}

export const createCmuxHost = (options: CmuxHostOptions = {}): CmuxHostAdapter => new CmuxHostAdapter(options);

export default CmuxHostAdapter;
