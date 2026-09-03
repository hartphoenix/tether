import type { HostCapabilities } from "../shared/contracts";
import type { HostAdapter, OpenViewRequest, OpenViewResult } from "./host-adapter";

export type BrowserCommandRunner = (command: string[], env?: NodeJS.ProcessEnv) => Promise<void>;
export type BrowserHostOptions = { run?: BrowserCommandRunner; open?: (url: string) => Promise<void>; env?: NodeJS.ProcessEnv };

function browserEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

export function platformOpenCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export async function runOpenCommand(command: string[], env = browserEnvironment()): Promise<void> {
  const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const status = await child.exited;
  if (status !== 0) {
    const output = child.stderr ? (await new Response(child.stderr).text()).trim() : "";
    throw new Error(output || `${command[0]} exited with status ${status}`);
  }
}

const capabilities: HostCapabilities = {
  embeddedBrowser: false,
  hiddenNavigation: false,
  widgetInstallation: false,
  fileNavigatorHook: false,
  revealFile: process.platform === "darwin",
};

/** Host-neutral adapter for the ordinary system browser. */
export class BrowserHostAdapter implements HostAdapter {
  readonly id = "browser" as const;
  private readonly run: BrowserCommandRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: BrowserHostOptions = {}) {
    this.run = options.run ?? (async (command, env) => runOpenCommand(command, env));
    this.environment = options.env ?? browserEnvironment();
    if (options.open) this.run = async (command) => options.open!(command.at(-1)!);
  }

  async detect(): Promise<boolean> { return true; }
  capabilities(): HostCapabilities { return { ...capabilities }; }
  async openView(request: OpenViewRequest): Promise<OpenViewResult> {
    await this.run(platformOpenCommand(request.url), this.environment);
    return { launchConsumed: true };
  }
  async openExternal(pathOrUrl: string): Promise<void> { await this.run(platformOpenCommand(pathOrUrl), this.environment); }
  async revealFile(path: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Reveal in Finder is available only on macOS.");
    await this.run(["open", "-R", path], this.environment);
  }
}

export function createBrowserHost(options: BrowserHostOptions = {}): BrowserHostAdapter {
  return new BrowserHostAdapter(options);
}

export default BrowserHostAdapter;
