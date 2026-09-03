#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../server/config";
import { cancelLaunch, controlLaunch, controlRecentsLaunch, controlRequest, ControlRequestError, statusDaemon, stopDaemon } from "../server/lifecycle";
import { createBrowserHost } from "../hosts/browser";
import { createWaveHost } from "../hosts/wave";
import { startWaveBridge } from "../hosts/wave-bridge";
import { createCmuxHost, CmuxHostAdapter, CmuxHostError, SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT, SUPPORTED_CMUX_VERSION } from "../hosts/cmux";
import { cmuxBridgeStatus, startCmuxBridge, stopCmuxBridge, type CmuxBridgeStatus } from "../hosts/cmux-bridge";
import type { HostAdapter } from "../hosts/host-adapter";
import type { ProtocolResponse } from "../shared/contracts";
import { RecentsRegistry } from "../recents/registry";
import { recordRecent } from "../recents/service";
import { installWaveLaunchers, uninstallWaveLaunchers, waveLauncherStatus } from "../hosts/wave-launchers";

export type CliDependencies = {
  config?: TetherConfig;
  open?: (url: string) => Promise<void>;
  readBody?: (path: string) => Promise<string>;
  host?: HostAdapter;
  cmuxHost?: CmuxHostAdapter;
  readCmuxBridgeStatus?: (config: TetherConfig) => Promise<CmuxBridgeStatus>;
};

async function launchHost(dependencies: CliDependencies): Promise<HostAdapter> {
  if (dependencies.host) return dependencies.host;
  if (!dependencies.open) {
    const wave = createWaveHost();
    if (await wave.detect()) return wave;
    const cmux = dependencies.cmuxHost ?? createCmuxHost();
    if (await cmux.detect()) return cmux;
  }
  return createBrowserHost({ open: dependencies.open });
}

function cmuxBridgeOptions(host: HostAdapter): { cmuxVersion?: string; cmuxBuild?: number; cmuxCommit?: string } {
  if (!(host instanceof CmuxHostAdapter)) return {};
  const cmuxVersion = host.detectedVersion();
  const cmuxBuild = host.detectedBuild();
  const cmuxCommit = host.detectedCommit();
  return {
    ...(cmuxVersion ? { cmuxVersion } : {}),
    ...(cmuxBuild === null ? {} : { cmuxBuild }),
    ...(cmuxCommit ? { cmuxCommit } : {}),
  };
}

function success<T>(command: string, data: T): ProtocolResponse<T> {
  return { protocol: 1, ok: true, command, data };
}

function failure(command: string, cause: unknown, code = "command_failed"): ProtocolResponse<never> {
  const details = cause && typeof cause === "object" ? (cause as { details?: unknown }).details : undefined;
  return {
    protocol: 1,
    ok: false,
    command,
    error: { code, message: cause instanceof Error ? cause.message : String(cause), ...(details === undefined ? {} : { details }) },
  };
}

const usageText = "Usage: mdreview open <file> [--focus|--no-focus] | recents [--focus|--no-focus] | recents add <file> | recent <1|2|3> [--focus|--no-focus] | cmux status | wave <status|install|uninstall> | daemon <status|stop> | document <read|save> <file> | pending <file> --actor <actor> | thread <file> <thread-id> | <reply|resolve|reopen> <file> <thread-id> --actor <actor> | acknowledge <file> --actor <actor> --through <seq> --body-revision <revision>";

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

function focusPreference(args: string[], firstFlagIndex: number): boolean {
  const trailing = args.slice(firstFlagIndex);
  if (trailing.some((value) => value !== "--focus" && value !== "--no-focus")) usage("Only --focus or --no-focus may follow the launch target.");
  const focusCount = trailing.filter((value) => value === "--focus").length;
  const noFocusCount = trailing.filter((value) => value === "--no-focus").length;
  if (focusCount > 1 || noFocusCount > 1) usage("Focus flags may be specified only once.");
  const focus = focusCount === 1;
  const noFocus = noFocusCount === 1;
  if (focus && noFocus) usage("--focus and --no-focus cannot be used together.");
  return !noFocus;
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
  if (argv[0] === "cmux") return `cmux.${argv[1] ?? ""}`;
  if (argv[0] === "recents" && argv[1] === "add") return "recents.add";
  if (["pending", "thread", "reply", "resolve", "reopen", "acknowledge"].includes(argv[0] ?? "")) return `review.${argv[0]}`;
  return argv[0] ?? "unknown";
}

export async function runCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<{ response: ProtocolResponse; exitCode: number }> {
  const command = commandName(argv);
  try {
    const config = dependencies.config ?? resolveConfig();
    if (argv[0] === "open" || argv[0] === "recent") {
      const focus = focusPreference(argv, 2);
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
      const target = host.launchTarget?.();
      const launch = await controlLaunch(config, canonicalPath, target);
      if (host.id === "wave" && !dependencies.host) await startWaveBridge(config, process.env, { wait: false });
      if (host.id === "cmux" && !dependencies.host) {
        try { await startCmuxBridge(config, process.env, cmuxBridgeOptions(host)); }
        catch (cause) { await cancelLaunch(config, launch.url); throw cause; }
      }
      if (process.env.TETHER_SUPPRESS_BROWSER !== "1") {
        try {
          const result = await host.openView({ url: launch.url, kind: "document", focus, allowFocusedFallback: focus, target });
          if (result?.launchConsumed === false) await cancelLaunch(config, launch.url);
        }
        catch (cause) { await cancelLaunch(config, launch.url); throw cause; }
      }
      return { response: success(argv[0], { path: launch.path, expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "recents" && argv[1] === "add") {
      if (!argv[2] || argv.length !== 3) usage();
      const host = await launchHost(dependencies);
      const result = await recordRecent(new RecentsRegistry(config.recentsPath), host, resolve(argv[2]), host.launchTarget?.());
      return {
        response: success(command, {
          path: result.entry.path,
          recentCount: result.entries.length,
          host: host.id,
          hostSynchronized: result.hostSynchronized,
        }),
        exitCode: 0,
      };
    }
    if (argv[0] === "recents") {
      const focus = focusPreference(argv, 1);
      const host = await launchHost(dependencies);
      const target = host.launchTarget?.();
      const launch = await controlRecentsLaunch(config, target);
      try {
        if (host.id === "wave" && !dependencies.host) await startWaveBridge(config, process.env, { wait: false });
        if (host.id === "cmux" && !dependencies.host) await startCmuxBridge(config, process.env, cmuxBridgeOptions(host));
        if (process.env.TETHER_SUPPRESS_BROWSER !== "1") {
          const result = await host.openView({ url: launch.url, kind: "recents", focus, allowFocusedFallback: focus, target });
          if (result?.launchConsumed === false) await cancelLaunch(config, launch.url);
        }
      } catch (cause) {
        await cancelLaunch(config, launch.url);
        throw cause;
      }
      return { response: success("recents", { expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "daemon" && argv[1] === "status") return { response: success(command, await statusDaemon(config)), exitCode: 0 };
    if (argv[0] === "daemon" && argv[1] === "stop") {
      await stopCmuxBridge(config).catch(() => {});
      return { response: success(command, await stopDaemon(config)), exitCode: 0 };
    }
    if (argv[0] === "cmux" && argv[1] === "status" && argv.length === 2) {
      const cmux = dependencies.cmuxHost ?? createCmuxHost();
      const detected = await cmux.detect();
      const version = cmux.detectedVersion();
      const build = cmux.detectedBuild();
      const commit = cmux.detectedCommit();
      const supported = detected && version === SUPPORTED_CMUX_VERSION && build === SUPPORTED_CMUX_BUILD && commit === SUPPORTED_CMUX_COMMIT;
      const target = cmux.launchTarget();
      let directPlacementReady = false;
      let directIssue: { code: string; message: string } | undefined;
      if (supported && target) {
        try { await cmux.probeSocket(); directPlacementReady = true; }
        catch (cause) {
          directIssue = { code: cause instanceof CmuxHostError ? cause.code : "socket_unavailable", message: cause instanceof Error ? cause.message : String(cause) };
        }
      } else if (detected) {
        directIssue = { code: supported ? "socket_unavailable" : "unsupported_version", message: supported ? "cmux target capture is unavailable." : `Tether supports cmux ${SUPPORTED_CMUX_VERSION}; detected ${version ?? "an unknown version"}.` };
      } else {
        directIssue = { code: "cmux_not_detected", message: "cmux was not detected in this terminal." };
      }
      const bridge = await (dependencies.readCmuxBridgeStatus ?? cmuxBridgeStatus)(config);
      return {
        response: success(command, {
          detected,
          supported,
          version,
          ...(build ? { build } : {}),
          ...(commit ? { commit } : {}),
          directPlacementReady,
          callbackPlacementReady: bridge.callbackPlacementReady,
          directPlacement: { ready: directPlacementReady, ...(directIssue ? { issue: directIssue } : {}) },
          callbackPlacement: { ready: bridge.callbackPlacementReady, ...(bridge.issue ? { issue: bridge.issue } : {}) },
          ...(directIssue ? { issue: directIssue } : bridge.issue ? { issue: bridge.issue } : {}),
        }),
        exitCode: 0,
      };
    }
    if (argv[0] === "wave" && argv[1] === "status") return { response: success(command, await waveLauncherStatus()), exitCode: 0 };
    if (argv[0] === "wave" && argv[1] === "install") return { response: success(command, await installWaveLaunchers({ recents: await new RecentsRegistry(config.recentsPath).list() })), exitCode: 0 };
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
    const coded = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
    const code = usageError ? "usage" : coded ?? (cause instanceof ControlRequestError ? cause.code : "command_failed");
    return { response: failure(command, cause, code), exitCode: usageError ? 2 : 1 };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(argv);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
