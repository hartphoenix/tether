import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export class TetherError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TetherError";
  }
}

/** Runs one Tether command and returns its protocol-v1 `data`, or throws a coded error. */
export type TetherRunner = (args: string[], env?: Record<string, string>) => Promise<unknown>;

// The plugin server inherits the Paseo daemon's environment, which may not
// carry the login shell's PATH. Tether's launchers need `bun` for source checkouts.
const commonBins = [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

function searchPath(): string {
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...current, ...commonBins.filter(bin => !current.includes(bin))].join(delimiter);
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** Configured path first, then PATH, then the packaged installer's default. */
export function resolveTether(configured: string): string {
  if (configured) {
    if (!executable(configured)) throw new TetherError("tether_not_found", `Tether is not executable at ${configured}.`);
    return configured;
  }
  for (const directory of searchPath().split(delimiter)) {
    const candidate = join(directory, "tether");
    if (executable(candidate)) return candidate;
  }
  throw new TetherError("tether_not_found", "Tether was not found. Install it, or set its path in the Tether plugin settings.");
}

// Launch context that must never leak from the Paseo daemon into Tether's host selection.
const launchContext = ["TETHER_PASEO_WORKSPACE_ID", "TETHER_PASEO_ORIGIN", "PASEO_TERMINAL_ID", "PASEO_AGENT_ID", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "WAVETERM"];

export function createTetherRunner(options: { binary: () => string; profile: () => string; timeoutMs?: number; env?: Record<string, string> }): TetherRunner {
  return (args, extra = {}) => new Promise((resolve, reject) => {
    let binary: string;
    try { binary = options.binary(); } catch (cause) { reject(cause); return; }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath(), TETHER_PROFILE: options.profile() };
    for (const name of launchContext) delete env[name];
    Object.assign(env, options.env, extra);
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 45_000);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", cause => { clearTimeout(timer); reject(new TetherError("tether_unavailable", cause.message)); });
    child.on("close", status => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8").trim();
      let envelope: { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };
      try { envelope = JSON.parse(text); }
      catch {
        const detail = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-3).join(" ");
        reject(new TetherError("tether_output_invalid", `tether ${args[0]} exited with ${status}${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (envelope.ok) resolve(envelope.data);
      else reject(new TetherError(envelope.error?.code ?? "tether_failed", envelope.error?.message ?? `tether ${args[0]} failed.`));
    });
  });
}
