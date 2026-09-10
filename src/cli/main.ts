#!/usr/bin/env bun
import { realpath, readFile, readlink, unlink, rename } from "node:fs/promises";
import { readBoundedInput, writeExport } from "./io";
import { usageText, commandSpecs, CliUsageError, parseCommand, requiredFlag, optionalFlag, readOptions, focusPreference, positiveInteger, usage } from "./commands";
import { dirname, resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../server/config";
import { cancelLaunch, controlLaunch, controlRecentsLaunch, controlRequest, ControlRequestError, ensureDaemon, statusDaemon, stopDaemon } from "../server/lifecycle";
import { createBrowserHost } from "../hosts/browser";
import { createWaveHost } from "../hosts/wave";
import { startWaveBridge } from "../hosts/wave-bridge";
import { createCmuxHost, CmuxHostAdapter, CmuxHostError, SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT, SUPPORTED_CMUX_VERSION } from "../hosts/cmux";
import { cmuxBridgeStatus, startCmuxBridge, stopCmuxBridge, type CmuxBridgeStatus } from "../hosts/cmux-bridge";
import type { HostAdapter } from "../hosts/host-adapter";
import type { ProtocolResponse } from "../shared/contracts";
import { RecentsRegistry } from "../recents/registry";
import { installWaveLaunchers, uninstallWaveLaunchers, waveLauncherStatus } from "../hosts/wave-launchers";
import { hostPreference, readHostPreference, saveHostPreference, seedWelcome, installAgentSkill, type HostPreference } from "./setup";
import { backupState, restoreState } from "./backup";
import { runtimeRoot } from "../runtime-paths";

export type CliDependencies = {
  config?: TetherConfig;
  open?: (url: string) => Promise<void>;
  readBody?: (path: string) => Promise<string>;
  host?: HostAdapter;
  cmuxHost?: CmuxHostAdapter;
  readCmuxBridgeStatus?: (config: TetherConfig) => Promise<CmuxBridgeStatus>;
};

async function launchHost(dependencies: CliDependencies, preference: HostPreference = "auto"): Promise<HostAdapter> {
  if (dependencies.host) return dependencies.host;
  if (preference === "browser") return createBrowserHost({ open: dependencies.open });
  if (preference === "wave" || preference === "cmux") {
    const host = preference === "wave" ? createWaveHost() : dependencies.cmuxHost ?? createCmuxHost();
    if (!await host.detect()) throw new Error(`Launch from ${preference}, or explicitly select --host browser.`);
    return host;
  }
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

async function bodyFile(path: string, dependencies: CliDependencies, limit = 256 * 1024): Promise<string> {
  if (dependencies.readBody) {
    const text = await dependencies.readBody(path);
    if (Buffer.byteLength(text) > limit) throw new ControlRequestError("input_too_large", `Input exceeds ${limit} bytes.`, 413);
    return text;
  }
  return readBoundedInput(path, limit);
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
  let command = commandName(argv);
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      return { response: success("help", { usage: usageText, commands: Object.values(commandSpecs).map(({ name, usage }) => ({ name, usage })) }), exitCode: 0 };
    }
    const parsed = parseCommand(argv);
    command = parsed.spec.name;
    if (parsed.help) return { response: success("help", { command, usage: parsed.spec.usage }), exitCode: 0 };
    const config = dependencies.config ?? resolveConfig();
    const selectedHost = parsed.flags.has("--host") ? hostPreference(optionalFlag(parsed, "--host")!) : await readHostPreference(config);
    if (command === "backup") return { response: success(command, await backupState(config, requiredFlag(parsed, "--output"))), exitCode: 0 };
    if (command === "restore") return { response: success(command, await restoreState(requiredFlag(parsed, "--source"), requiredFlag(parsed, "--directory"))), exitCode: 0 };
    if (command === "uninstall") {
      if (!process.env.TETHER_INSTALL_ROOT) throw new Error("This command removes a managed installation, not a source checkout.");
      if ((await statusDaemon(config)).running) throw new Error("Save your work and quit Tether before uninstalling: tether daemon stop");
      const root = dirname(dirname(runtimeRoot()));
      const installation = JSON.parse(await readFile(resolve(root, "install.json"), "utf8"));
      if (typeof installation.binDirectory !== "string") throw new Error("Missing installation metadata.");
      const commands = ["tether", "mdreview"].map(name => ({ path: resolve(installation.binDirectory, name), target: resolve(root, "current", name) }));
      for (const command of commands) {
        const target = await readlink(command.path).catch(() => null);
        if (target === null || await realpath(resolve(dirname(command.path), target)) !== await realpath(command.target)) throw new Error(`Command has changed; preserved: ${command.path}`);
      }
      const wave = await waveLauncherStatus();
      if (wave.installed.length) await uninstallWaveLaunchers();
      for (const command of commands) await unlink(command.path);
      const retained = resolve(root, `uninstalled-${Date.now()}`);
      await rename(resolve(root, "current"), retained);
      return { response: success(command, { removedCommands: commands.map(command => command.path), retainedInstallation: retained, privateData: config.configDir,
        message: "Documents, private reviews, agent skills, and release files are retained. Reinstall to restore command launchers." }), exitCode: 0 };
    }
    if (command === "update") {
      if (!process.env.TETHER_INSTALL_ROOT) throw new Error("Source checkouts update through Git. Use the release installer for a managed installation.");
      if ((await statusDaemon(config)).running) throw new Error("Save your work and quit Tether before updating: tether daemon stop");
      const output = resolve(config.configDir, "..", `backup-before-update-${Date.now()}`);
      const backup = await backupState(config, output);
      const version = optionalFlag(parsed, "--version");
      const root = dirname(dirname(runtimeRoot()));
      const installation = JSON.parse(await readFile(resolve(root, "install.json"), "utf8"));
      const child = Bun.spawn(["/bin/bash", resolve(runtimeRoot(), "install.sh"), "--no-open", ...(version ? ["--version", version] : [])], { stdout: "pipe", stderr: "inherit", env: { ...process.env, TETHER_INSTALL_DIR: root, TETHER_BIN_DIR: installation.binDirectory } });
      const log = await new Response(child.stdout).text();
      if (await child.exited !== 0) throw new Error(`Update failed; backup retained at ${backup.directory}. ${log}`);
      return { response: success(command, { backup, message: log, next: "Run tether to start the updated release." }), exitCode: 0 };
    }
    if (command === "doctor") {
      return { response: success(command, { platform: process.platform, architecture: process.arch, runtime: Bun.version,
        configDirectory: config.configDir, hostPreference: selectedHost, daemon: await statusDaemon(config),
        wave: await waveLauncherStatus(), cmux: (await runCli(["cmux", "status"], dependencies)).response,
      }), exitCode: 0 };
    }
    if (command === "setup") {
      if (parsed.flags.has("--host")) await saveHostPreference(config, selectedHost);
      const skillDirectory = optionalFlag(parsed, "--agent-directory");
      const agent = skillDirectory ? await installAgentSkill(skillDirectory) : undefined;
      const wave = parsed.flags.has("--wave") ? await installWaveLaunchers() : undefined;
      const path = await seedWelcome(config);
      await controlRequest(config, "/control/folio/add", { paths: [path] });
      if (!parsed.flags.has("--no-open")) {
        const opened = await runCli(["open", path, "--host", selectedHost], dependencies);
        if (!opened.response.ok) return opened;
      }
      return { response: success(command, { path, hostPreference: selectedHost, agent, wave, opened: !parsed.flags.has("--no-open") && process.env.TETHER_SUPPRESS_BROWSER !== "1",
        next: "Use tether to open Folio. Optional integrations: tether setup --wave or --agent-directory <skills-directory>.",
      }), exitCode: 0 };
    }
    if (argv[0] === "open" || argv[0] === "recent") {
      const focus = focusPreference(parsed);
      let path: string | undefined = parsed.positionals[0];
      if (argv[0] === "recent") {
        const index = Number(path);
        if (!Number.isSafeInteger(index) || index < 1 || index > 3) usage("recent requires an index from 1 through 3.");
        const folio = await controlRequest<{ files?: Array<{ path?: unknown; missing?: unknown }> }>(config, "/control/folio/list", { view: "active", sort: "opened" });
        const entry = folio.files?.filter((item) => item.missing !== true)[index - 1];
        path = typeof entry?.path === "string" ? entry.path : undefined;
        if (!path) throw new Error(`Recent Markdown file ${index} is unavailable.`);
      }
      if (!path) usage();
      const canonicalPath = await realpath(resolve(path));
      const host = await launchHost(dependencies, selectedHost);
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
      return { response: success(command, await controlRequest(config, "/control/folio/add", { paths: [resolve(parsed.positionals[0]!)] })), exitCode: 0 };
    }
    if (command === "recents" || command === "folio") {
      const focus = focusPreference(parsed);
      const host = await launchHost(dependencies, selectedHost);
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
      return { response: success(command, { expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
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

    if (["document.move", "document.outline", "document.context", "document.diff", "quote-candidates", "operation", "event"].includes(command)) {
      const action = command.startsWith("document.") ? command.replace(".", "/") : `review/${command}`;
      return { response: success(command, await controlRequest(config, `/control/${action}`, {
        path: resolve(parsed.positionals[0]!), ...readOptions(parsed),
        ...(command === "document.move" ? { target: resolve(parsed.positionals[1]!) } : {}),
        ...(command === "document.context" ? { threadId: parsed.positionals[1]! } : {}),
        ...(command === "document.diff" ? { fromRevision: requiredFlag(parsed, "--from-revision") } : {}),
        ...(command === "quote-candidates" ? { quote: requiredFlag(parsed, "--quote") } : {}),
        ...(command === "operation" ? { operationId: requiredFlag(parsed, "--operation-id") } : {}),
        ...(command === "event" ? { eventId: parsed.positionals[1]! } : {}),
      })), exitCode: 0 };
    }
    if (command === "document.read") {
      return { response: success(command, await controlRequest(config, "/control/document/read", { path: resolve(parsed.positionals[0]!) })), exitCode: 0 };
    }
    if (command === "document.save") {
      const expectedBodyRevision = requiredFlag(parsed, "--expected-body-revision");
      const body = await bodyFile(requiredFlag(parsed, "--body-file"), dependencies, 16 * 1024 * 1024);
      return { response: success(command, await controlRequest(config, "/control/document/save", { path: resolve(parsed.positionals[0]!), body, expectedBodyRevision })), exitCode: 0 };
    }

    if (command === "pending") {
      const actor = requiredFlag(parsed, "--actor");
      return { response: success(command, await controlRequest(config, "/control/review/pending", { path: resolve(parsed.positionals[0]!), actor, ...readOptions(parsed), ...(optionalFlag(parsed, "--consumer") ? { consumer: optionalFlag(parsed, "--consumer") } : {}) })), exitCode: 0 };
    }
    if (command === "thread" || command === "threads") {
      const beforeSequence = optionalFlag(parsed, "--before-sequence");
      const limit = optionalFlag(parsed, "--limit");
      const request = {
        path: resolve(parsed.positionals[0]!), ...readOptions(parsed),
        ...(command === "thread" ? { threadId: parsed.positionals[1]! } : {}),
        ...(command === "threads" && optionalFlag(parsed, "--status") ? { status: optionalFlag(parsed, "--status") } : {}),
        ...(beforeSequence ? { beforeSequence: positiveInteger(beforeSequence, "--before-sequence") } : {}),
        ...(limit ? { limit: positiveInteger(limit, "--limit") } : {}),
      };
      return { response: success(command, await controlRequest(config, `/control/review/${command}`, request)), exitCode: 0 };
    }
    if (["reply", "resolve", "reopen", "edit", "delete"].includes(command)) {
      const actor = requiredFlag(parsed, "--actor");
      const expectedThreadSequence = optionalFlag(parsed, "--expected-thread-sequence");
      const body = (command === "reply" || command === "edit") ? await bodyFile(requiredFlag(parsed, "--body-file"), dependencies) : undefined;
      return {
        response: success(command, await controlRequest(config, `/control/review/${command}`, {
          path: resolve(parsed.positionals[0]!), threadId: parsed.positionals[1]!, actor,
          ...(["edit", "delete"].includes(command) ? { targetId: parsed.positionals[2]! } : {}),
          operationId: requiredFlag(parsed, "--operation-id"),
          ...(body === undefined ? {} : { body }),
          ...(expectedThreadSequence ? { expectedThreadSequence: positiveInteger(expectedThreadSequence, "--expected-thread-sequence") } : {}),
        })),
        exitCode: 0,
      };
    }
    if (command === "acknowledge") {
      const actor = requiredFlag(parsed, "--actor");
      return {
        response: success(command, await controlRequest(config, "/control/review/acknowledge", {
          path: resolve(parsed.positionals[0]!), actor, cursor: requiredFlag(parsed, "--cursor"), operationId: requiredFlag(parsed, "--operation-id"),
          ...(optionalFlag(parsed, "--consumer") ? { consumer: optionalFlag(parsed, "--consumer") } : {}),
        })),
        exitCode: 0,
      };
    }
    if (command === "comment") {
      const body = await bodyFile(requiredFlag(parsed, "--body-file"), dependencies);
      return {
        response: success(command, await controlRequest(config, "/control/review/comment", {
          path: resolve(parsed.positionals[0]!), actor: requiredFlag(parsed, "--actor"), quote: requiredFlag(parsed, "--quote"), body,
          operationId: requiredFlag(parsed, "--operation-id"),
          ...(optionalFlag(parsed, "--candidate-id") ? { candidateId: optionalFlag(parsed, "--candidate-id") } : {}),
          ...(optionalFlag(parsed, "--expected-body-revision") ? { expectedBodyRevision: optionalFlag(parsed, "--expected-body-revision") } : {}),
        })),
        exitCode: 0,
      };
    }
    if (command.startsWith("folio.")) {
      const action = command.slice("folio.".length);
      if (action === "sync") return { response: success(command, await controlRequest(config, "/control/folio/sync", {})), exitCode: 0 };
      if (action === "list") {
        return { response: success(command, await controlRequest(config, "/control/folio/list", {
          ...(optionalFlag(parsed, "--view") ? { view: optionalFlag(parsed, "--view") } : {}),
          ...(optionalFlag(parsed, "--sort") ? { sort: optionalFlag(parsed, "--sort") } : {}),
          ...((parsed.flags.has("--open-threads") || parsed.flags.has("--needs-attention")) ? { needsAttention: true } : {}),
          ...(parsed.flags.has("--missing") ? { missing: true } : {}),
          ...(optionalFlag(parsed, "--query") ? { query: optionalFlag(parsed, "--query") } : {}),
          ...(optionalFlag(parsed, "--directory") ? { directory: optionalFlag(parsed, "--directory") } : {}),
          ...(optionalFlag(parsed, "--repository") ? { repository: optionalFlag(parsed, "--repository") } : {}),
        })), exitCode: 0 };
      }
      if (["add", "archive", "restore"].includes(action)) {
        return { response: success(command, await controlRequest(config, `/control/folio/${action}`, { paths: parsed.positionals.map((path) => resolve(path)), ...(parsed.flags.has("--confirm") ? { confirmed: true } : {}) })), exitCode: 0 };
      }
      if (action === "pin") {
        return { response: success(command, await controlRequest(config, "/control/folio/pin", { paths: parsed.positionals.map((path) => resolve(path)), pinned: !parsed.flags.has("--off") })), exitCode: 0 };
      }
      if (action === "locate") {
        return { response: success(command, await controlRequest(config, "/control/folio/locate", { path: resolve(parsed.positionals[0]!), target: resolve(requiredFlag(parsed, "--new-path")) })), exitCode: 0 };
      }
      if (action === "settings") {
        const retention = optionalFlag(parsed, "--retention");
        if (retention !== undefined && !parsed.flags.has("--confirm")) usage("Changing archive retention requires --confirm.");
        const setting = retention === undefined ? {} : retention === "forever" ? { retention: { mode: "forever" } } : retention === "immediate" ? { retention: { mode: "immediate" } } : { retention: { mode: "days", days: positiveInteger(retention, "--retention") } };
        return { response: success(command, await controlRequest(config, "/control/folio/settings", { ...setting, ...(parsed.flags.has("--confirm") ? { confirmed: true } : {}) })), exitCode: 0 };
      }
      if (action === "export") {
        const output = resolve(requiredFlag(parsed, "--output"));
        const packageData = await controlRequest(config, "/control/folio/export", { paths: parsed.positionals.map((path) => resolve(path)) });
        await writeExport(output, `${JSON.stringify(packageData)}\n`, parsed.flags.has("--overwrite"));
        return { response: success(command, { output }), exitCode: 0 };
      }
      if (action === "import") {
        const packagePath = requiredFlag(parsed, "--package");
        let packageData: unknown;
        try { packageData = JSON.parse(await readBoundedInput(packagePath, 32 * 1024 * 1024)); }
        catch (cause) { throw new ControlRequestError("invalid_package", `Unable to read package: ${cause instanceof Error ? cause.message : String(cause)}`, 400); }
        return { response: success(command, await controlRequest(config, "/control/folio/import", { package: packageData, directory: resolve(requiredFlag(parsed, "--directory")) })), exitCode: 0 };
      }
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
