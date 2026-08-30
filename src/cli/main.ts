#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../server/config";
import { cancelLaunch, controlLaunch, statusDaemon, stopDaemon } from "../server/lifecycle";
import { createBrowserHost } from "../hosts/browser";
import type { ProtocolResponse } from "../shared/contracts";

export type CliDependencies = {
  config?: TetherConfig;
  open?: (url: string) => Promise<void>;
};

function success<T>(command: string, data: T): ProtocolResponse<T> {
  return { protocol: 1, ok: true, command, data };
}

function failure(command: string, cause: unknown, code = "command_failed"): ProtocolResponse<never> {
  return { protocol: 1, ok: false, command, error: { code, message: cause instanceof Error ? cause.message : String(cause) } };
}

class CliUsageError extends Error {
  constructor() {
    super("Usage: mdreview open <file> | mdreview daemon status | mdreview daemon stop");
    this.name = "CliUsageError";
  }
}

function usage(): never {
  throw new CliUsageError();
}

export async function runCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<{ response: ProtocolResponse; exitCode: number }> {
  const command = argv[0] === "open" ? "open" : argv[0] === "daemon" ? `daemon.${argv[1] ?? ""}` : argv[0] ?? "";
  try {
    const config = dependencies.config ?? resolveConfig();
    if (argv[0] === "open") {
      const path = argv[1];
      if (!path) usage();
      // The daemon may have been started from another working directory.
      // Resolve the explicit authority in the CLI process before contacting it.
      const canonicalPath = await realpath(resolve(path));
      const launch = await controlLaunch(config, canonicalPath);
      if (process.env.TETHER_SUPPRESS_BROWSER !== "1") {
        const browser = createBrowserHost({ open: dependencies.open });
        try { await browser.openView(launch.url); }
        catch (cause) { await cancelLaunch(config, launch.url); throw cause; }
      }
      return { response: success("open", { path: launch.path, expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "daemon" && argv[1] === "status") return { response: success("daemon.status", await statusDaemon(config)), exitCode: 0 };
    if (argv[0] === "daemon" && argv[1] === "stop") return { response: success("daemon.stop", await stopDaemon(config)), exitCode: 0 };
    usage();
  } catch (cause) {
    const usageError = cause instanceof CliUsageError;
    return { response: failure(command || "unknown", cause, usageError ? "usage" : "command_failed"), exitCode: usageError ? 2 : 1 };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(argv);
  // Exactly one JSON object is written to stdout. All child-process output is
  // suppressed by lifecycle.ts; diagnostics are represented structurally.
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
