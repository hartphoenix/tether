#!/usr/bin/env -S bun --no-env-file
import { pendingAgentSkillReviews, listAgentSkillReviews, readAgentSkillReview, mergeAgentSkill } from "./agent-skills";
import { diagnosticText, errorDetails, operationError } from "../shared/diagnostics";
import { commandResult } from "./results";
import { realpath, readFile, readlink, unlink, rename } from "node:fs/promises";
import { readBoundedInput, writeExport } from "./io";
import { usageText, commandSpecs, CliUsageError, parseCommand, requiredFlag, optionalFlag, readOptions, focusPreference, positiveInteger, usage } from "./commands";
import { dirname, resolve } from "node:path";
import { resolveConfig, type TetherConfig } from "../server/config";
import { cancelLaunch, controlLaunch, controlRecentsLaunch, controlRequest, ControlRequestError, ensureAutomaticDaemon, ensureDaemon, statusDaemon, stopDaemon } from "../server/lifecycle";
import { createBrowserHost } from "../hosts/browser";
import { createWaveHost } from "../hosts/wave";
import { startWaveBridge } from "../hosts/wave-bridge";
import { createCmuxHost, CmuxHostAdapter, CmuxHostError, isSupportedCmuxVersion, MINIMUM_CMUX_VERSION } from "../hosts/cmux";
import { cmuxBridgeStatus, startCmuxBridge, stopCmuxBridge, type CmuxBridgeStatus } from "../hosts/cmux-bridge";
import type { HostAdapter } from "../hosts/host-adapter";
import type { ProtocolResponse } from "../shared/contracts";
import { RecentsRegistry } from "../recents/registry";
import { installWaveLaunchers, uninstallWaveLaunchers, waveLauncherStatus, waveInstallationDetected, type WaveLauncherOptions } from "../hosts/wave-launchers";
import { agentSetupGuidance, hostPreference, readHostPreference, saveHostPreference, seedWelcome, installAgentSkill, type HostPreference } from "./setup";
import { backupState, restoreState } from "./backup";
import { installVerifiedRelease } from "../releases/verified-update";
import { UpdateService } from "../server/updates";
import { runtimeRoot } from "../runtime-paths";
import type { RecoveryView } from "../hosts/recovery";
import { beginAttempt, readAutomation, disableAutomation } from "../server/automation-state";
import { runtimeFingerprint } from "../server/startup-assets";
import { enableStartup, disableStartup, startupStatus } from "./startup";

export type CliDependencies = {
  waveLaunchers?: WaveLauncherOptions;
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
  return { protocol: 1, ok: true, command, data: commandResult(command, data) as T };
}

function failure(command: string, cause: unknown, code = "command_failed"): ProtocolResponse<never> {
  const details = errorDetails(cause);
  const message = diagnosticText(cause instanceof Error ? cause.message : String(cause));
  const evidence = details.diagnostic as Record<string, unknown> | undefined;
  if (evidence && evidence.message === message && Object.keys(evidence).every(key => key === "message" || key === "code") && (evidence.code === undefined || evidence.code === code)) delete details.diagnostic;
  return {
    protocol: 1,
    ok: false,
    command,
    error: { code, message, ...(Object.keys(details).length ? { details } : {}) },
  };
}

async function launchFailure(config: TetherConfig, url: string, cause: unknown): Promise<unknown> {
  try { await cancelLaunch(config, url); }
  catch (cleanup) { return operationError(cause, { cleanup: errorDetails(cleanup) }); }
  return cause;
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
  if (argv[0] === "skills") return `skills.${argv[1] ?? ""}`;
  if (argv[0] === "daemon") return `daemon.${argv[1] ?? ""}`;
  if (argv[0] === "document") return `document.${argv[1] ?? ""}`;
  if (argv[0] === "wave") return `wave.${argv[1] ?? ""}`;
  if (argv[0] === "cmux") return `cmux.${argv[1] ?? ""}`;
  if (argv[0] === "recents" && argv[1] === "add") return "recents.add";
  if (["pending", "thread", "reply", "resolve", "reopen", "acknowledge"].includes(argv[0] ?? "")) return `review.${argv[0]}`;
  return argv[0] ?? "unknown";
}

const reportingGuidance = "For user-facing summaries, report what completed, what did not, and any decision needed in plain language. Omit diagnostic codes, host implementation names, and internal paths unless the user asks for technical diagnosis. Keep these details for your own recovery decisions. A warning does not undo a completed operation.";

export async function runCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<{ response: ProtocolResponse; exitCode: number }> {
  let command = commandName(argv);
  const completed: Array<{ step: string; path?: string }> = [];
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      return { response: success("help", { usage: usageText, reporting: reportingGuidance, commands: Object.values(commandSpecs).map(({ name, usage }) => ({ name, usage })) }), exitCode: 0 };
    }
    if (argv.length === 2 && argv[1] === "--help") {
      const commands = Object.values(commandSpecs).filter(spec => spec.name.startsWith(`${argv[0]}.`)).map(({ name, usage }) => ({ name, usage }));
      if (commands.length) return { response: success("help", { command: argv[0], usage: commandSpecs[argv[0]!]?.usage ?? `mdreview ${argv[0]} <command> [arguments] [flags]`, commands, reporting: reportingGuidance }), exitCode: 0 };
    }
    const parsed = parseCommand(argv);
    command = parsed.spec.name;
    if (parsed.help) return { response: success("help", { command, usage: parsed.spec.usage, ...(command === "setup" ? { agentSetup: agentSetupGuidance } : {}), reporting: reportingGuidance }), exitCode: 0 };
    const config = dependencies.config ?? resolveConfig();
    if (command === "startup.status") return { response: success(command, await startupStatus(config)), exitCode: 0 };
    if (command === "startup.enable") return { response: success(command, await enableStartup(config)), exitCode: 0 };
    if (command === "startup.disable") return { response: success(command, await disableStartup(config)), exitCode: 0 };
    if (command === "cmux.attach") {
      const state = await readAutomation(config);
      if (!state.enabled || !state.runtime) return { response: success(command, { attached: false, reason: "startup_disabled" }), exitCode: 0 };
      if (await realpath(runtimeRoot()) !== state.runtime.root || await realpath(process.execPath) !== await realpath(resolve(state.runtime.root, "runtime/bun"))) throw new Error("Automatic attachment must use the enabled packaged runtime.");
      if (await runtimeFingerprint(state.runtime.root) !== state.runtime.digest) throw new Error("Startup runtime changed; attachment is blocked.");
      if (!process.env.CMUX_SOCKET_CAPABILITY || !process.env.CMUX_SOCKET_PATH) throw new Error("Attach requires fresh cmux authority.");
      const attempt = await beginAttempt(config, "bridge", state.runtime);
      if (!(await statusDaemon(config)).running) {
        await ensureAutomaticDaemon(config, state.runtime);
      }
      await startCmuxBridge(config, process.env, { attempt });
      return { response: success(command, { attached: true }), exitCode: 0 };
    }
    if (command === "resume") {
      const inspect = parsed.flags.has("--inspect");
      const host = await launchHost(dependencies, "cmux");
      if (!host.recoverViews) throw new Error("This host does not support in-place recovery.");
      const inventory = await controlRequest<{ views: RecoveryView[] }>(config, "/control/recovery/views", {}, { start: !inspect });
      if (!inspect && !dependencies.host) await startCmuxBridge(config, process.env, cmuxBridgeOptions(host));
      return { response: success(command, await host.recoverViews(inventory.views, inspect)), exitCode: 0 };
    }
    const selectedHost = parsed.flags.has("--host") ? hostPreference(optionalFlag(parsed, "--host")!) : ["open", "recent", "recents", "folio", "setup"].includes(command) ? await readHostPreference(config) : "auto";
    if (command === "skills.list") return { response: success(command, { reviews: await listAgentSkillReviews(config) }), exitCode: 0 };
    if (command === "skills.read") return { response: success(command, await readAgentSkillReview(config, parsed.positionals[0]!)), exitCode: 0 };
    if (command === "skills.merge") {
      await mergeAgentSkill(config, parsed.positionals[0]!, requiredFlag(parsed, "--expected-revision"), resolve(requiredFlag(parsed, "--body-file")));
      return { response: success(command, { merged: true, id: parsed.positionals[0]!, reviewNeeded: false }), exitCode: 0 };
    }
    if (command === "backup") return { response: success(command, await backupState(config, requiredFlag(parsed, "--output"))), exitCode: 0 };
    if (command === "restore") return { response: success(command, await restoreState(requiredFlag(parsed, "--source"), requiredFlag(parsed, "--directory"))), exitCode: 0 };
    if (command === "uninstall") {
      if (!process.env.TETHER_INSTALL_ROOT) throw new Error("This command removes a managed installation, not a source checkout.");
      await disableAutomation(config);
      if ((await statusDaemon(config)).running) throw new Error("Save your work and quit Tether before uninstalling: tether daemon stop");
      const startup = await disableStartup(config);
      if (!startup.unloaded || !startup.stopped || startup.preserved) throw new Error("Startup cleanup is incomplete; installation was preserved.");
      const root = dirname(dirname(runtimeRoot()));
      const installation = JSON.parse(await readFile(resolve(root, "install.json"), "utf8"));
      if (typeof installation.binDirectory !== "string") throw new Error("Missing installation metadata.");
      const commands = ["tether", "mdreview"].map(name => ({ path: resolve(installation.binDirectory, name), target: resolve(root, "current", name) }));
      for (const command of commands) {
        const target = await readlink(command.path).catch(() => null);
        if (target === null || await realpath(resolve(dirname(command.path), target)) !== await realpath(command.target)) throw new Error(`Command has changed; preserved: ${command.path}`);
      }
      const wave = await waveLauncherStatus();
      if (wave.installed.length) { await uninstallWaveLaunchers(); completed.push({ step: "wave_launchers_removed" }); }
      for (const command of commands) { await unlink(command.path); completed.push({ step: "command_removed", path: command.path }); }
      const retained = resolve(root, `uninstalled-${Date.now()}`);
      await rename(resolve(root, "current"), retained);
      return { response: success(command, { removedCommands: commands.map(command => command.path), retainedInstallation: retained, privateData: config.configDir,
        message: "Documents, private reviews, agent skills, and release files are retained. Reinstall to restore command launchers." }), exitCode: 0 };
    }
    if (command === "update") {
      if (!process.env.TETHER_INSTALL_ROOT) throw new Error("Source checkouts update through Git. Use the release installer for a managed installation.");
      if (parsed.flags.has("--check")) {
        const checked = (await statusDaemon(config)).running
          ? await controlRequest(config, "/control/updates/check", {}, { timeoutMs: 60_000 })
          : await new UpdateService({ config, root: runtimeRoot() }).status(true);
        return { response: success(command, checked), exitCode: 0 };
      }
      if ((await statusDaemon(config)).running) throw new Error("Save your work and quit Tether before updating: tether daemon stop");
      await disableAutomation(config, true);
      const output = resolve(config.configDir, "..", `backup-before-update-${Date.now()}`);
      const backup = await backupState(config, output);
      completed.push({ step: "backup_created", path: backup.directory });
      const version = optionalFlag(parsed, "--version");
      const log = await installVerifiedRelease(runtimeRoot(), config, version);
      return { response: success(command, { backup, message: log, next: "Run tether to start the updated release." }), exitCode: 0 };
    }
    if (command === "doctor") {
      return { response: success(command, { platform: process.platform, architecture: process.arch, runtime: Bun.version,
        agentSkillReviews: await pendingAgentSkillReviews(config),
        configDirectory: config.configDir, hostPreference: await readHostPreference(config).catch(cause => ({ error: errorDetails(cause) })), daemon: await statusDaemon(config),
        wave: await waveLauncherStatus(), cmux: (await runCli(["cmux", "status"], dependencies)).response,
      }), exitCode: 0 };
    }
    if (command === "setup") {
      if (parsed.flags.has("--host")) { await saveHostPreference(config, selectedHost); completed.push({ step: "host_preference_saved", path: resolve(config.configDir, "launch.json") }); }
      const skillDirectory = optionalFlag(parsed, "--agent-directory");
      const agent = skillDirectory ? await installAgentSkill(skillDirectory, config) : undefined;
      if (agent) completed.push({ step: "agent_skill_installed", path: agent.path });
      const wave = (parsed.flags.has("--wave") || await waveInstallationDetected(dependencies.waveLaunchers)) ? await installWaveLaunchers(dependencies.waveLaunchers) : undefined;
      if (wave) completed.push({ step: "wave_launchers_installed" });
      const path = await seedWelcome(config);
      completed.push({ step: "welcome_document_ready", path });
      await controlRequest(config, "/control/folio/add", { paths: [path] });
      completed.push({ step: "registered", path });
      if (!parsed.flags.has("--no-open")) {
        const opened = await runCli(["open", path, "--host", selectedHost], dependencies);
        if (!opened.response.ok) throw Object.assign(new Error(opened.response.error.message), { code: opened.response.error.code, details: opened.response.error.details });
      }
      return { response: success(command, { path, hostPreference: selectedHost, agent, wave, opened: !parsed.flags.has("--no-open") && process.env.TETHER_SUPPRESS_BROWSER !== "1",
        next: "Use tether to open Folio. Setup adds the Folio widget when Wave is detected; tether setup --wave also installs it explicitly.",
        ...(!agent ? { agentSetup: agentSetupGuidance } : {}),
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
      const launch = await controlLaunch(config, canonicalPath, target, optionalFlag(parsed, "--resume"));
      completed.push({ step: "registered", path: canonicalPath });
      if (host.id === "wave" && !dependencies.host) {
        try { await startWaveBridge(config, process.env, { wait: false }); }
        catch (cause) { throw await launchFailure(config, launch.url, cause); }
      }
      if (host.id === "cmux" && !dependencies.host) {
        try { await startCmuxBridge(config, process.env, cmuxBridgeOptions(host)); }
        catch (cause) { throw await launchFailure(config, launch.url, cause); }
      }
      if (process.env.TETHER_SUPPRESS_BROWSER !== "1") {
        try {
          const result = await host.openView({ url: launch.url, kind: "document", focus, allowFocusedFallback: focus, target });
          if (result?.launchConsumed === false) await cancelLaunch(config, launch.url);
        }
        catch (cause) { throw await launchFailure(config, launch.url, cause); }
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
        throw await launchFailure(config, launch.url, cause);
      }
      return { response: success(command, { expiresAt: launch.expiresAt, opened: process.env.TETHER_SUPPRESS_BROWSER !== "1" }), exitCode: 0 };
    }
    if (argv[0] === "daemon" && argv[1] === "status") return { response: success(command, await statusDaemon(config)), exitCode: 0 };
    if (argv[0] === "daemon" && argv[1] === "stop") {
      return { response: success(command, await stopDaemon(config)), exitCode: 0 };
    }
    if (argv[0] === "cmux" && argv[1] === "status" && argv.length === 2) {
      const cmux = dependencies.cmuxHost ?? createCmuxHost();
      const detected = await cmux.detect();
      const version = cmux.detectedVersion();
      const build = cmux.detectedBuild();
      const commit = cmux.detectedCommit();
      const supported = detected && isSupportedCmuxVersion(version);
      const target = cmux.launchTarget();
      let directPlacementReady = false;
      let directIssue: { code: string; message: string } | undefined;
      if (supported && target) {
        try { await cmux.probeSocket(); directPlacementReady = true; }
        catch (cause) {
          directIssue = { code: cause instanceof CmuxHostError ? cause.code : "socket_unavailable", message: cause instanceof Error ? cause.message : String(cause) };
        }
      } else if (detected) {
        directIssue = { code: supported ? "socket_unavailable" : "unsupported_version", message: supported ? "cmux target capture is unavailable." : `Tether requires cmux ${MINIMUM_CMUX_VERSION} or later; detected ${version ?? "an unknown version"}.` };
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
        catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; throw new ControlRequestError("invalid_package", `Unable to read package: ${cause instanceof Error ? cause.message : String(cause)}`, 400); }
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
    const uncertain = cause && typeof cause === "object" && (cause as { details?: { outcome?: string } }).details?.outcome === "outcome_unknown";
    const reported = completed.length ? operationError(cause, { outcome: uncertain ? "outcome_unknown" : "partially_applied", completed }) : cause;
    return { response: failure(command, reported, code), exitCode: usageError ? 2 : 1 };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(argv);
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
