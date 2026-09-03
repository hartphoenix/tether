import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision, splitAnnotationLedger } from "../src/core/annotation-ledger";
import { DocumentAccessError } from "../src/documents/document-service";
import { runCli } from "../src/cli/main";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import type { HostAdapter, OpenViewRequest } from "../src/hosts/host-adapter";
import { CmuxHostAdapter, SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT } from "../src/hosts/cmux";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("returns one versioned open result without exposing the launch ticket", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, "Example\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const opened: string[] = [];
  const result = await runCli(["open", path], { config, open: async (url) => { opened.push(url); } });
  expect(result.exitCode).toBe(0);
  expect(result.response).toEqual({
    protocol: 1,
    ok: true,
    command: "open",
    data: { path: await realpath(path), expiresAt: expect.any(Number), opened: true },
  });
  expect(JSON.stringify(result.response)).not.toContain("ticket");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("/launch?ticket=");
});

test("opens the indexed recent file through the normal path-scoped launch", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-recent-"));
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  const config = resolveConfig({ profile: "recent", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const { RecentsRegistry } = await import("../src/recents/registry");
  const registry = new RecentsRegistry(config.recentsPath);
  await registry.add(first);
  await registry.add(second);
  const opened: string[] = [];
  const result = await runCli(["recent", "2"], { config, open: async (url) => { opened.push(url); } });
  expect(result.response).toMatchObject({ ok: true, command: "recent", data: { path: await realpath(first), opened: true } });
  expect(opened).toHaveLength(1);
});

test("captures one host target per launch and propagates view kind and focus", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-host-operation-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, "Example\n");
  const config = resolveConfig({ profile: "host-operation", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const requests: OpenViewRequest[] = [];
  let captures = 0;
  const host: HostAdapter = {
    id: "browser",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true }),
    launchTarget: () => ({ host: "browser", capture: String(++captures) }),
    openView: async (request) => { requests.push(request); },
    openExternal: async () => {},
  };

  expect((await runCli(["open", path, "--no-focus"], { config, host })).response).toMatchObject({ ok: true, command: "open" });
  expect((await runCli(["recents", "--focus"], { config, host })).response).toMatchObject({ ok: true, command: "recents" });
  expect(captures).toBe(2);
  expect(requests).toEqual([
    { url: expect.stringContaining("/launch?ticket="), kind: "document", focus: false, allowFocusedFallback: false, target: { host: "browser", capture: "1" } },
    { url: expect.stringContaining("/recents/launch?ticket="), kind: "recents", focus: true, allowFocusedFallback: true, target: { host: "browser", capture: "2" } },
  ]);

  const conflicting = await runCli(["open", path, "--focus", "--no-focus"], { config, host });
  expect(conflicting).toMatchObject({ exitCode: 2, response: { error: { code: "usage" } } });
  expect(captures).toBe(2);

  let unusedRecentsUrl = "";
  const unused = await runCli(["recents"], {
    config,
    host: { ...host, openView: async (request) => { unusedRecentsUrl = request.url; return { launchConsumed: false }; } },
  });
  expect(unused).toMatchObject({ exitCode: 0, response: { data: { opened: true } } });
  expect((await fetch(unusedRecentsUrl, { redirect: "manual" })).status).toBe(401);

  const recentsFailure = await runCli(["recents", "--no-focus"], {
    config,
    host: { ...host, openView: async () => { throw Object.assign(new Error("Dock disabled"), { code: "dock_unavailable" }); } },
  });
  expect(recentsFailure).toMatchObject({ exitCode: 1, response: { command: "recents", error: { code: "dock_unavailable" } } });
});

test("reports cmux detection, direct placement, and callback readiness independently", async () => {
  const windowId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const surfaceId = "33333333-3333-4333-8333-333333333333";
  const cmuxHost = new CmuxHostAdapter({
    cmuxPath: "cmux",
    env: { CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: surfaceId, CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
    externalHost: { openExternal: async () => {}, revealFile: async () => {} },
    run: async (command) => {
      if (command.includes("--version")) return { exitCode: 0, stdout: `cmux 0.64.22 (${SUPPORTED_CMUX_BUILD}) [${SUPPORTED_CMUX_COMMIT}]`, stderr: "" };
      if (command.includes("identify")) return { exitCode: 0, stdout: JSON.stringify({ caller: { window_id: windowId, workspace_id: workspaceId, surface_id: surfaceId } }), stderr: "" };
      return { exitCode: 0, stdout: "PONG", stderr: "" };
    },
  });
  const result = await runCli(["cmux", "status"], {
    cmuxHost,
    readCmuxBridgeStatus: async () => ({ running: true, callbackPlacementReady: true }),
  });
  expect(result).toEqual({
    exitCode: 0,
    response: {
      protocol: 1,
      ok: true,
      command: "cmux.status",
      data: {
        detected: true,
        supported: true,
        version: "0.64.22",
        build: SUPPORTED_CMUX_BUILD,
        commit: SUPPORTED_CMUX_COMMIT,
        directPlacementReady: true,
        callbackPlacementReady: true,
        directPlacement: { ready: true },
        callbackPlacement: { ready: true },
      },
    },
  });
});

test("keeps direct and callback placement issues separate in cmux status", async () => {
  const windowId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const surfaceId = "33333333-3333-4333-8333-333333333333";
  const cmuxHost = new CmuxHostAdapter({
    cmuxPath: "cmux",
    env: { CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: surfaceId, CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
    externalHost: { openExternal: async () => {}, revealFile: async () => {} },
    run: async (command) => {
      if (command.includes("--version")) return { exitCode: 0, stdout: `cmux 0.64.22 (${SUPPORTED_CMUX_BUILD}) [${SUPPORTED_CMUX_COMMIT}]`, stderr: "" };
      if (command.includes("identify")) return { exitCode: 0, stdout: JSON.stringify({ caller: { window_id: windowId, workspace_id: workspaceId, surface_id: surfaceId } }), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "Unauthorized" };
    },
  });
  const result = await runCli(["cmux", "status"], {
    cmuxHost,
    readCmuxBridgeStatus: async () => ({
      running: false,
      callbackPlacementReady: false,
      issue: { code: "bridge_relaunch_required", message: "Relaunch from cmux." },
    }),
  });
  expect(result.response).toMatchObject({
    ok: true,
    data: {
      directPlacement: { ready: false, issue: { code: "socket_unauthorized" } },
      callbackPlacement: { ready: false, issue: { code: "bridge_relaunch_required" } },
    },
  });
});

test("does not report a matching cmux semver with the wrong build as supported", async () => {
  const cmuxHost = new CmuxHostAdapter({
    cmuxPath: "cmux",
    env: {
      CMUX_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222",
      CMUX_SURFACE_ID: "33333333-3333-4333-8333-333333333333",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    },
    externalHost: { openExternal: async () => {}, revealFile: async () => {} },
    run: async () => ({ exitCode: 0, stdout: `cmux 0.64.22 (${SUPPORTED_CMUX_BUILD + 1}) [${SUPPORTED_CMUX_COMMIT}]`, stderr: "" }),
  });
  const result = await runCli(["cmux", "status"], {
    cmuxHost,
    readCmuxBridgeStatus: async () => ({ running: true, callbackPlacementReady: true }),
  });
  expect(result.response).toMatchObject({
    ok: true,
    data: {
      detected: true,
      supported: false,
      version: "0.64.22",
      build: SUPPORTED_CMUX_BUILD + 1,
      commit: SUPPORTED_CMUX_COMMIT,
      directPlacement: { ready: false, issue: { code: "unsupported_version" } },
      callbackPlacement: { ready: true },
    },
  });
});

test("rejects unknown or duplicate launch flags and non-exact cmux status commands", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-flags-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, "Example\n");
  const config = resolveConfig({ profile: "flags", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const invalid = [
    ["open", path, "--unknown"],
    ["open", path, "--focus", "--focus"],
    ["recent", "1", "--no-focus", "--no-focus"],
    ["recents", "--unknown"],
    ["recents", "--focus", "--focus"],
    ["recents", "add", path, "extra"],
    ["cmux", "status", "extra"],
  ];
  for (const argv of invalid) {
    expect(await runCli(argv, { config })).toMatchObject({ exitCode: 2, response: { error: { code: "usage" } } });
  }
});

test("adds a recent file through the application transaction and reports host synchronization", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-recents-add-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const config = resolveConfig({ profile: "recents-add", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const synchronized: string[][] = [];
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    launchTarget: () => ({ host: "wave" }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
  };

  const result = await runCli(["recents", "add", path], { config, host });
  expect(result).toMatchObject({
    exitCode: 0,
    response: { ok: true, command: "recents.add", data: { path: await realpath(path), recentCount: 1, host: "wave", hostSynchronized: true } },
  });
  expect(synchronized).toEqual([[await realpath(path)]]);
});

test("returns a failed recents add when host synchronization fails", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-recents-add-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review\n");
  const config = resolveConfig({ profile: "recents-add-failure", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const host: HostAdapter = {
    id: "wave",
    detect: async () => true,
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
    openView: async () => {},
    openExternal: async () => {},
    recentsChanged: async () => { throw new Error("Wave update failed"); },
  };

  const result = await runCli(["recents", "add", path], { config, host });
  expect(result).toMatchObject({ exitCode: 1, response: { ok: false, command: "recents.add", error: { message: "Wave update failed" } } });
});

test("uses a documented structured usage failure", async () => {
  const result = await runCli(["unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.response).toMatchObject({ protocol: 1, ok: false, command: "unknown", error: { code: "usage" } });
});

test("requires control authentication and closes each command's temporary grant", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-control-"));
  directories.push(directory);
  const path = join(directory, "private.md");
  await writeFile(path, "Private document\n");
  const config = resolveConfig({ profile: "control", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const unauthorized = await fetch(`${daemon.origin}/control/document/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  expect(unauthorized.status).toBe(403);
  expect(await unauthorized.json()).toMatchObject({ error: { code: "forbidden" } });

  expect((await runCli(["document", "read", path], { config })).exitCode).toBe(0);
  await expect(daemon.service.read(await realpath(path))).rejects.toBeInstanceOf(DocumentAccessError);
});

test("runs the complete agent document and thread workflow through a reused daemon", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-cli-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review target\n");
  const config = resolveConfig({ profile: "agent", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const seedGrant = await daemon.service.open(path);
  const initial = await daemon.service.read(seedGrant);
  const seeded = await daemon.service.appendComment({
    session: seedGrant,
    actor: "hart",
    expectedBodyRevision: initial.bodyRevision,
    body: "Please revise and explain.",
    anchor: { exact: "Review", prefix: "", suffix: " target", projectionStart: 0, projectionEnd: 6, bodyRevision: initial.bodyRevision },
  });
  daemon.service.close(seedGrant);
  const threadId = (seeded.annotations.events[0] as { id: string }).id;

  // Keep a browser session open while the CLI mutates the same canonical file.
  const browserGrant = await daemon.service.open(path);
  const launch = daemon.mintTicket(browserGrant);
  const exchange = await fetch(launch.url, { redirect: "manual" });
  const location = exchange.headers.get("location")!;
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];

  const read = await runCli(["document", "read", path], { config });
  expect(read.exitCode).toBe(0);
  expect(read.response).toMatchObject({ protocol: 1, ok: true, command: "document.read", data: { body: "Review target\n", bodyRevision: initial.bodyRevision } });

  const pending = await runCli(["pending", path, "--actor", "assistant"], { config });
  expect(pending.response).toMatchObject({ ok: true, command: "review.pending", data: { events: [{ id: threadId, type: "comment" }], maxSequence: 1 } });
  expect(JSON.stringify(pending.response)).not.toContain('"thread"');
  expect(JSON.stringify(pending.response)).not.toContain("Review target");

  expect((await runCli(["thread", path, threadId], { config })).response).toMatchObject({ ok: true, command: "review.thread", data: { thread: { id: threadId, status: "open" } } });
  expect((await runCli(["reply", path, threadId, "--actor", "assistant", "--body-file", "-"], { config, readBody: async () => "Applied the requested revision.\nSecond line." })).response).toMatchObject({ ok: true, command: "review.reply", data: { maxSequence: 2 } });
  expect((await runCli(["resolve", path, threadId, "--actor", "assistant"], { config })).response).toMatchObject({ ok: true, command: "review.resolve", data: { maxSequence: 3, unresolvedCount: 0 } });
  const reopened = await runCli(["reopen", path, threadId, "--actor", "assistant"], { config });
  expect(reopened.response).toMatchObject({ ok: true, command: "review.reopen", data: { maxSequence: 4, unresolvedCount: 1 } });

  const ledgerBeforeSave = splitAnnotationLedger(await readFile(path, "utf8")).ledgerText;
  const saved = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], {
    config,
    readBody: async () => "Revised by agent.\n\nMultiline body.\n",
  });
  expect(saved.response).toMatchObject({ ok: true, command: "document.save", data: { bodyRevision: bodyRevision("Revised by agent.\n\nMultiline body.\n"), ledgerRevision: expect.any(String) } });
  expect(splitAnnotationLedger(await readFile(path, "utf8")).ledgerText).toBe(ledgerBeforeSave);
  const ledgerAfterSave = splitAnnotationLedger(await readFile(path, "utf8")).ledgerText;
  expect(ledgerAfterSave).toContain("Applied the requested revision.");

  const browserRead = await fetch(`${daemon.origin}${location}api/file`, { headers: { cookie } });
  expect((await browserRead.json() as { body: string }).body).toBe("Revised by agent.\n\nMultiline body.\n");

  const savedRevision = bodyRevision("Revised by agent.\n\nMultiline body.\n");
  expect((await runCli(["acknowledge", path, "--actor", "assistant", "--through", "4", "--body-revision", savedRevision], { config })).response).toMatchObject({ ok: true, command: "review.acknowledge", data: { maxSequence: 5 } });
  expect((await runCli(["pending", path, "--actor", "assistant"], { config })).response).toMatchObject({ ok: true, data: { events: [] } });

  const conflict = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], { config, readBody: async () => "Stale overwrite\n" });
  expect(conflict).toMatchObject({ exitCode: 1, response: { ok: false, command: "document.save", error: { code: "conflict" } } });
  const missing = await runCli(["document", "read", join(directory, "missing.md")], { config });
  expect(missing).toMatchObject({ exitCode: 1, response: { error: { code: "document_not_found" } } });
  const invalidThread = await runCli(["thread", path, "missing-thread"], { config });
  expect(invalidThread).toMatchObject({ exitCode: 1, response: { error: { code: "thread_not_found" } } });
});

test("reports a malformed ledger as read-only and refuses agent saves", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-malformed-"));
  directories.push(directory);
  const path = join(directory, "broken.md");
  await writeFile(path, "Body\n<!-- wave-annotations:v1\nnot-json\n-->\n");
  const config = resolveConfig({ profile: "broken", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const read = await runCli(["document", "read", path], { config });
  expect(read.response).toMatchObject({ ok: true, data: { body: "Body\n", readOnly: true, ledgerError: expect.any(String) } });
  const revision = (read.response as { data: { bodyRevision: string } }).data.bodyRevision;
  const save = await runCli(["document", "save", path, "--expected-body-revision", revision, "--body-file", "-"], { config, readBody: async () => "Replacement\n" });
  expect(save).toMatchObject({ exitCode: 1, response: { error: { code: "ledger_invalid" } } });
});
