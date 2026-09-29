import { ProcessPool } from "./process-pool";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { TetherError } from "./errors";
export { TetherError } from "./errors";

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
    if (!executable(configured)) throw new TetherError("tether_not_found", "Tether command is not executable. Check its path in plugin settings.");
    return configured;
  }
  for (const directory of searchPath().split(delimiter)) {
    const candidate = join(directory, "tether");
    if (executable(candidate)) return candidate;
  }
  throw new TetherError("tether_not_found", "Tether was not found. Install it, or set its path in the Tether plugin settings.");
}

// Inherited routing and arbitrary credentials are deliberately absent. Explicit routing
// below is supplied only by plugin handlers, never copied from the Paseo environment.
const inheritedNames = ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "TETHER_RUNTIME_DIR", "TETHER_CONFIG_DIR", "TETHER_INSTALL_ROOT"];
const routingNames = ["TETHER_PASEO_WORKSPACE_ID", "TETHER_PASEO_ORIGIN"];

export function childEnvironment(profile: string, overrides: Record<string, string> = {}, routing: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = overrides[name] ?? process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = overrides.PATH ?? searchPath();
  env.TETHER_PROFILE = profile;
  for (const name of routingNames) if (routing[name] !== undefined) env[name] = routing[name];
  return env;
}

const messages: Record<string, string> = {
  usage: "This Tether command is unsupported. Update Tether and reload the plugin.",
  host_not_connected: "Paseo is not connected to Tether. Reopen Folio and try again.",
  daemon_unreachable: "Tether could not be reached. Check the connection in plugin settings.",
  daemon_start_timeout: "Tether did not become ready in time. Check daemon status before retrying.",
  file_not_found: "The document could not be found. Check its location.",
  path_not_found: "The document could not be found. Check its location.",
  permission_denied: "Tether cannot access this document. Check file permissions.",
  tether_failed: "Tether could not complete the command. Check daemon status and plugin settings.",
};

export type RunnerOptions = {
  binary: () => string;
  profile: () => string;
  timeoutMs?: number;
  killGraceMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  pool?: ProcessPool;
};

export function createTetherRunner(options: RunnerOptions): TetherRunner {
  const pool = options.pool ?? new ProcessPool();
  return async (args, extra = {}) => {
    const controller = new AbortController();
    let failure = new TetherError("tether_cancelled", "Tether connection changed. The command may already have completed.");
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => { failure = new TetherError("tether_timeout", "Tether timed out. The command may already have completed; check its result before retrying."); controller.abort(); }, options.timeoutMs ?? 45_000);
    const { signal } = controller;
    let release: (() => void) | undefined;
    try {
      // Resolve these once, before queueing, so an invocation never changes target.
      const binary = options.binary();
      const env = childEnvironment(options.profile(), options.env, extra);
      release = await pool.acquire(args[0] === "paseo" && args[1] === "wait", signal);
      if (signal.aborted) throw failure;
      const releaseChild = release;
      const result = new Promise<unknown>((resolve, reject) => {
        const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        release = undefined; // Retain capacity until the process exits AND its output is settled.
        let exited = false, settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let stdoutSize = 0, stderrSize = 0;
        const stdout: Buffer[] = [];
        const settle = (error?: TetherError, value?: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (exited) releaseChild();
          if (error) reject(error); else resolve(value);
        };
        const terminate = (error: TetherError) => {
          if (settled) return;
          settle(error);
          stdout.length = 0;
          child.stdout.destroy();
          child.stderr.destroy();
          if (!exited) {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, options.killGraceMs ?? 250);
          }
        };
        const abort = () => terminate(failure);
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdoutSize += chunk.length;
          if (stdoutSize > (options.stdoutBytes ?? 16 * 1024 * 1024)) terminate(new TetherError("tether_output_limit", "Tether output exceeded the supported size. Reduce the Folio size or check the configured command."));
          else stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrSize += chunk.length;
          if (stderrSize > (options.stderrBytes ?? 64 * 1024)) terminate(new TetherError("tether_output_limit", "Tether produced excessive diagnostics. Check the configured command."));
        });
        child.on("error", () => {
          // A failed kill can also emit error; only a spawn failure proves no child exists.
          if (child.pid === undefined) exited = true;
          terminate(new TetherError("tether_unavailable", "Tether could not be started or stopped. Check its path and permissions in plugin settings."));
        });
        child.on("exit", () => { exited = true; clearTimeout(killTimer); if (settled) releaseChild(); });
        child.on("close", status => {
          if (settled) return;
          try {
            const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8"));
            if (!envelope || envelope.protocol !== 1 || typeof envelope.ok !== "boolean") throw new Error();
            if (envelope.ok && status === 0) settle(undefined, envelope.data);
            else {
              const code = typeof envelope.error?.code === "string" && Object.hasOwn(messages, envelope.error.code) ? envelope.error.code : "tether_failed";
              settle(new TetherError(code, messages[code]!));
            }
          } catch { settle(new TetherError("tether_output_invalid", "Tether returned an invalid response. Check the configured command and version.")); }
        });
        if (signal.aborted) abort();
      });
      return await result;
    } catch (cause) {
      if (signal.aborted) throw failure;
      if (cause instanceof TetherError) throw cause;
      throw new TetherError("tether_unavailable", "Tether could not be started. Check its path and permissions in plugin settings.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      release?.();
    }
  };
}
