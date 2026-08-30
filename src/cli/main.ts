#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../server/config";
import { cancelLaunch, controlLaunch, controlRecentsLaunch, controlRequest, ControlRequestError, statusDaemon, stopDaemon } from "../server/lifecycle";
import { createBrowserHost } from "../hosts/browser";
import { createWaveHost } from "../hosts/wave";
import { startWaveBridge } from "../hosts/wave-bridge";
import type { HostAdapter } from "../hosts/host-adapter";
import type { ProtocolResponse } from "../shared/contracts";
import { RecentsRegistry } from "../recents/registry";
import { installWaveLaunchers, uninstallWaveLaunchers, waveLauncherStatus } from "../hosts/wave-launchers";

export type CliDependencies = {
  config?: TetherConfig;
  open?: (url: string) => Promise<void>;
  readBody?: (path: string) => Promise<string>;
  host?: HostAdapter;
};

async function launchHost(dependencies: CliDependencies): Promise<HostAdapter> {
  if (dependencies.host) return dependencies.host;
  if (!dependencies.open) {
    const wave = createWaveHost();
    if (await wave.detect()) return wave;
  }
  return createBrowserHost({ open: dependencies.open });
}

function success<T>(command: string, data: T): ProtocolResponse<T> {
  return { protocol: 1, ok: true, command, data };
}

function failure(command: string, cause: unknown, code = "command_failed"): ProtocolResponse<never> {
  const details = cause instanceof ControlRequestError ? cause.details : undefined;
  return {
    protocol: 1,
    ok: false,
    command,
    error: { code, message: cause instanceof Error ? cause.message : String(cause), ...(details === undefined ? {} : { details }) },
  };
}

const usageText = "Usage: mdreview open <file> | recents | recent <1|2|3> | wave <status|install|uninstall> | daemon <status|stop> | document <read|save> <file> | pending <file> --actor <actor> | thread <file> <thread-id> | <reply|resolve|reopen> <file> <thread-id> --actor <actor> | acknowledge <file> --actor <actor> --through <seq> --body-revision <revision>";

class CliUsageError extends Error {
  constructor(message = usageText) {
    super(message);
    this.name = "CliUsageError";
  }
}

function usage(message?: string): never {
  throw new CliUsageError(message ? `${message} ${usageText}` : usageText);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function requiredFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) usage(`${name} is required.`);
  return value;
}

async function bodyFile(path: string, dependencies: CliDependencies): Promise<string> {
  if (dependencies.readBody) return dependencies.readBody(path);
  if (path === "-") return new Response(Bun.stdin).text();
  return readFile(resolve(path), "utf8");
}

function commandName(argv: string[]): string {
  if (argv[0] === "daemon") return `daemon.${argv[1] ?? ""}`;
  if (argv[0] === "document") return `document.${argv[1] ?? ""}`;
  if (argv[0] === "wave") return `wave.${argv[1] ?? ""}`;
  if (["pending", "thread", "reply", "resolve", "reopen", "acknowledge"].includes(argv[0] ?? "")) return `review.${argv[0]}`;
  return argv[0] ?? "unknown";
}

export async function runCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<{ response: ProtocolResponse; exitCode: number }> {
  const command = commandName(argv);
  try {
    const config = dependencies.config ?? resolveConfig();
    if (argv[0] === "open" || argv[0] === "recent") {
      let path = argv[1];
      if (argv[0] === "recent") {
        const index = Number(path);
        if (!Number.isSafeInteger(index) || index < 1 || index > 3) usage("recent requires an index from 1 through 3.");
        path = (await new RecentsRegistry(config.recentsPath).paths())[index - 1];
        if (!path) throw new Error(`Recent Markdown file ${index} is unavailable.`);
      }
      if (!path) usage();
      const canonicalPath = await realpath(resolve(path));
      const host = await launchHost(dependencies);
      if (host.id === "wave" && !dependencies.host) await startWaveBridge(config);
      const launch = await controlLaunch(config, canonicalPath, host.launchTarget?.());
      if (process.env.TETHER_SUPPRESS_BROWSER !== "1") {
        try { await host.openView(launch.url, host.launchTarget?.()); }
        catch (cause) { await cancelLaunch(config, launch.url); throw cause; }
      }
      return { response: success(argv[0], { path: launch.path, expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "recents") {
      const host = await launchHost(dependencies);
      if (host.id === "wave" && !dependencies.host) await startWaveBridge(config);
      const launch = await controlRecentsLaunch(config, host.launchTarget?.());
      if (process.env.TETHER_SUPPRESS_BROWSER !== "1") await host.openView(launch.url, host.launchTarget?.());
      return { response: success("recents", { expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "daemon" && argv[1] === "status") return { response: success(command, await statusDaemon(config)), exitCode: 0 };
    if (argv[0] === "daemon" && argv[1] === "stop") return { response: success(command, await stopDaemon(config)), exitCode: 0 };
    if (argv[0] === "wave" && argv[1] === "status") return { response: success(command, await waveLauncherStatus()), exitCode: 0 };
    if (argv[0] === "wave" && argv[1] === "install") return { response: success(command, await installWaveLaunchers()), exitCode: 0 };
    if (argv[0] === "wave" && argv[1] === "uninstall") return { response: success(command, await uninstallWaveLaunchers()), exitCode: 0 };

    if (argv[0] === "document" && argv[1] === "read") {
      if (!argv[2]) usage();
      return { response: success(command, await controlRequest(config, "/control/document/read", { path: resolve(argv[2]) })), exitCode: 0 };
    }
    if (argv[0] === "document" && argv[1] === "save") {
      if (!argv[2]) usage();
      const expectedBodyRevision = requiredFlag(argv, "--expected-body-revision");
      const body = await bodyFile(requiredFlag(argv, "--body-file"), dependencies);
      return { response: success(command, await controlRequest(config, "/control/document/save", { path: resolve(argv[2]), body, expectedBodyRevision })), exitCode: 0 };
    }

    if (argv[0] === "pending") {
      if (!argv[1]) usage();
      return { response: success(command, await controlRequest(config, "/control/review/pending", { path: resolve(argv[1]), actor: requiredFlag(argv, "--actor") })), exitCode: 0 };
    }
    if (argv[0] === "thread") {
      if (!argv[1] || !argv[2]) usage();
      return { response: success(command, await controlRequest(config, "/control/review/thread", { path: resolve(argv[1]), threadId: argv[2] })), exitCode: 0 };
    }
    if (["reply", "resolve", "reopen"].includes(argv[0] ?? "")) {
      if (!argv[1] || !argv[2]) usage();
      const actor = requiredFlag(argv, "--actor");
      const body = argv[0] === "reply" ? await bodyFile(requiredFlag(argv, "--body-file"), dependencies) : undefined;
      return {
        response: success(command, await controlRequest(config, `/control/review/${argv[0]}`, {
          path: resolve(argv[1]), threadId: argv[2], actor, ...(body === undefined ? {} : { body }),
        })),
        exitCode: 0,
      };
    }
    if (argv[0] === "acknowledge") {
      if (!argv[1]) usage();
      const through = Number(requiredFlag(argv, "--through"));
      if (!Number.isSafeInteger(through) || through < 1) usage("--through must be a positive integer.");
      return {
        response: success(command, await controlRequest(config, "/control/review/acknowledge", {
          path: resolve(argv[1]), actor: requiredFlag(argv, "--actor"), through, bodyRevision: requiredFlag(argv, "--body-revision"),
        })),
        exitCode: 0,
      };
    }
    usage();
  } catch (cause) {
    const usageError = cause instanceof CliUsageError;
    const code = usageError ? "usage" : cause instanceof ControlRequestError ? cause.code : "command_failed";
    return { response: failure(command, cause, code), exitCode: usageError ? 2 : 1 };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(argv);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
