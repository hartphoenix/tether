import type { HostCapabilities } from "../shared/contracts";
import type { HostAdapter, HostTarget } from "./host-adapter";
import type { RecentEntry } from "../recents/registry";
import { syncWaveRecentLaunchers } from "./wave-launchers";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUPPORTED_WAVE_VERSION = "0.14.5";

export type WaveCommandResult = { exitCode: number; stdout: string; stderr: string };
export type WaveCommandRunner = (command: string[], env: NodeJS.ProcessEnv) => Promise<WaveCommandResult>;
export type WaveHostOptions = {
  env?: NodeJS.ProcessEnv;
  run?: WaveCommandRunner;
  wshPath?: string;
  syncRecents?: (entries: RecentEntry[]) => Promise<unknown>;
};

function defaultWshPath(env: NodeJS.ProcessEnv): string {
  if (env.WAVETERM_WSHBINARY) return env.WAVETERM_WSHBINARY;
  if (env.WAVETERM_WSH_PATH) return env.WAVETERM_WSH_PATH;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "waveterm", "bin", "wsh");
  return "wsh";
}

function commandEnvironment(source: NodeJS.ProcessEnv, target?: HostTarget): NodeJS.ProcessEnv {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "WAVETERM_JWT", "WAVETERM_WORKSPACEID", "WAVETERM_TABID", "WAVETERM_BLOCKID"];
  const env = Object.fromEntries(allowed.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]!]]));
  if (target?.workspaceId) env.WAVETERM_WORKSPACEID = target.workspaceId;
  if (target?.tabId) env.WAVETERM_TABID = target.tabId;
  if (target?.blockId) env.WAVETERM_BLOCKID = target.blockId;
  return env;
}

async function runWaveCommand(command: string[], env: NodeJS.ProcessEnv): Promise<WaveCommandResult> {
  const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function parseVersion(output: string): string | null {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1] ?? null;
}

function jwtBlockId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { blockid?: unknown };
    return typeof payload.blockid === "string" && payload.blockid ? payload.blockid : undefined;
  } catch { return undefined; }
}

type WaveBlock = { blockid?: unknown; tabid?: unknown; workspaceid?: unknown };

const unavailable: HostCapabilities = {
  embeddedBrowser: false,
  hiddenNavigation: false,
  widgetInstallation: false,
  fileNavigatorHook: false,
  revealFile: true,
};

export class WaveHostAdapter implements HostAdapter {
  readonly id = "wave" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: WaveCommandRunner;
  private readonly wshPath: string;
  private readonly syncRecents: (entries: RecentEntry[]) => Promise<unknown>;
  private version: string | null = null;

  constructor(options: WaveHostOptions = {}) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? runWaveCommand;
    this.wshPath = options.wshPath ?? defaultWshPath(this.env);
    this.syncRecents = options.syncRecents ?? ((entries) => syncWaveRecentLaunchers(entries));
  }

  async detect(): Promise<boolean> {
    if (this.env.WAVETERM !== "1" && this.env.TERM_PROGRAM !== "waveterm") return false;
    const result = await this.run([this.wshPath, "version"], commandEnvironment(this.env));
    this.version = result.exitCode === 0 ? parseVersion(`${result.stdout} ${result.stderr}`) : null;
    return this.version !== null;
  }

  capabilities(): HostCapabilities {
    if (!this.version) return { ...unavailable };
    return {
      embeddedBrowser: true,
      hiddenNavigation: this.version === SUPPORTED_WAVE_VERSION,
      widgetInstallation: true,
      fileNavigatorHook: false,
      revealFile: true,
    };
  }

  launchTarget(): HostTarget | undefined {
    if (!this.version) return undefined;
    return {
      host: "wave",
      version: this.version,
      ...(this.env.WAVETERM_WORKSPACEID ? { workspaceId: this.env.WAVETERM_WORKSPACEID } : {}),
      ...(this.env.WAVETERM_TABID ? { tabId: this.env.WAVETERM_TABID } : {}),
      ...(this.env.WAVETERM_BLOCKID || jwtBlockId(this.env.WAVETERM_JWT) ? { blockId: this.env.WAVETERM_BLOCKID ?? jwtBlockId(this.env.WAVETERM_JWT)! } : {}),
    };
  }

  private async resolveTarget(target?: HostTarget): Promise<HostTarget | undefined> {
    if (target?.tabId) return target;
    const blockId = target?.blockId ?? this.env.WAVETERM_BLOCKID ?? jwtBlockId(this.env.WAVETERM_JWT);
    if (!blockId) return target;
    const result = await this.run([this.wshPath, "blocks", "list", "--json"], commandEnvironment(this.env, target));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Wave could not resolve the launcher block.");
    let blocks: WaveBlock[];
    try { blocks = JSON.parse(result.stdout) as WaveBlock[]; }
    catch { throw new Error("Wave returned an invalid block list while resolving the launcher tab."); }
    const block = Array.isArray(blocks) ? blocks.find((value) => value?.blockid === blockId) : undefined;
    if (!block || typeof block.tabid !== "string") throw new Error("Wave could not find the tab containing the launcher block.");
    return {
      ...target,
      blockId,
      tabId: block.tabid,
      ...(typeof block.workspaceid === "string" ? { workspaceId: block.workspaceid } : {}),
    };
  }

  async openView(url: string, target?: HostTarget): Promise<void> {
    if (!this.env.WAVETERM_JWT) throw new Error("Wave view placement requires WAVETERM_JWT. Relaunch Tether from a Wave widget or terminal.");
    const destination = await this.resolveTarget(target);
    const command = this.version === SUPPORTED_WAVE_VERSION
      ? [this.wshPath, "createblock", "web", `url=${url}`, "web:hidenav=true"]
      : [this.wshPath, "web", "open", url];
    const result = await this.run(command, commandEnvironment(this.env, destination));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `wsh exited with status ${result.exitCode}`);
    const launcherBlock = target?.blockId ?? this.env.WAVETERM_BLOCKID ?? jwtBlockId(this.env.WAVETERM_JWT);
    if (this.env.TETHER_WAVE_LAUNCHER === "1" && launcherBlock) {
      const closed = await this.run([this.wshPath, "deleteblock", "-b", launcherBlock], commandEnvironment(this.env, destination));
      // Placement already succeeded and the browser may already be exchanging
      // its single-use ticket. Cleanup failure must not make the CLI cancel it.
      void closed;
    }
  }

  async openExternal(pathOrUrl: string): Promise<void> {
    const result = await this.run(["open", pathOrUrl], commandEnvironment(this.env));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `open exited with status ${result.exitCode}`);
  }

  async revealFile(path: string): Promise<void> {
    const result = await this.run(["open", "-R", path], commandEnvironment(this.env));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `open exited with status ${result.exitCode}`);
  }

  async recentsChanged(entries: RecentEntry[]): Promise<void> {
    await this.syncRecents(entries);
  }
}

export const createWaveHost = (options: WaveHostOptions = {}): WaveHostAdapter => new WaveHostAdapter(options);
