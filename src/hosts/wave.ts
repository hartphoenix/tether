import type { HostCapabilities } from "../shared/contracts";
import type { HostAdapter, HostTarget } from "./host-adapter";

export const SUPPORTED_WAVE_VERSION = "0.14.5";

export type WaveCommandResult = { exitCode: number; stdout: string; stderr: string };
export type WaveCommandRunner = (command: string[], env: NodeJS.ProcessEnv) => Promise<WaveCommandResult>;
export type WaveHostOptions = { env?: NodeJS.ProcessEnv; run?: WaveCommandRunner };

function commandEnvironment(source: NodeJS.ProcessEnv, target?: HostTarget): NodeJS.ProcessEnv {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "WAVETERM_JWT", "WAVETERM_WORKSPACEID", "WAVETERM_TABID"];
  const env = Object.fromEntries(allowed.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]!]]));
  if (target?.workspaceId) env.WAVETERM_WORKSPACEID = target.workspaceId;
  if (target?.tabId) env.WAVETERM_TABID = target.tabId;
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
  private version: string | null = null;

  constructor(options: WaveHostOptions = {}) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? runWaveCommand;
  }

  async detect(): Promise<boolean> {
    if (this.env.WAVETERM !== "1" && this.env.TERM_PROGRAM !== "waveterm") return false;
    const result = await this.run(["wsh", "version"], commandEnvironment(this.env));
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
    };
  }

  async openView(url: string, target?: HostTarget): Promise<void> {
    if (!this.env.WAVETERM_JWT) throw new Error("Wave view placement requires WAVETERM_JWT. Relaunch Tether from a Wave widget or terminal.");
    const command = this.version === SUPPORTED_WAVE_VERSION
      ? ["wsh", "createblock", "web", `url=${url}`, "web:hidenav=true"]
      : ["wsh", "web", "open", url];
    const result = await this.run(command, commandEnvironment(this.env, target));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `wsh exited with status ${result.exitCode}`);
  }

  async openExternal(pathOrUrl: string): Promise<void> {
    const result = await this.run(["open", pathOrUrl], commandEnvironment(this.env));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `open exited with status ${result.exitCode}`);
  }

  async revealFile(path: string): Promise<void> {
    const result = await this.run(["open", "-R", path], commandEnvironment(this.env));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `open exited with status ${result.exitCode}`);
  }
}

export const createWaveHost = (options: WaveHostOptions = {}): WaveHostAdapter => new WaveHostAdapter(options);
