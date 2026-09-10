import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision } from "../src/core/annotation-ledger";
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
  await runCli(["folio", "add", first], { config });
  await Bun.sleep(2);
  await runCli(["folio", "add", second], { config });
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
  const daemon = createDaemon({ config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const result = await runCli(["recents", "add", path], { config, host });
  expect(result).toMatchObject({
    exitCode: 0,
    response: { ok: true, command: "recents.add", data: { added: [{ path: await realpath(path) }], hostSynchronized: true } },
  });
  expect(synchronized.at(-1)).toEqual([await realpath(path)]);
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
  const daemon = createDaemon({ config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const result = await runCli(["recents", "add", path], { config, host });
  expect(result).toMatchObject({
    exitCode: 0,
    response: {
      ok: true,
      command: "recents.add",
      data: {
        added: [{ path: await realpath(path) }],
        hostSynchronized: false,
        hostIssue: { code: "host_sync_failed", message: "Wave update failed" },
      },
    },
  });
});

test("uses a documented structured usage failure", async () => {
  const result = await runCli(["unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.response).toMatchObject({ protocol: 1, ok: false, command: "unknown", error: { code: "usage" } });
});

test("rejects malformed review input before reading a body or discovering a daemon", async () => {
  let reads = 0;
  const path = "/tmp/--literal.md";
  for (const argv of [
    ["pending", path, "--actor", "assistant", "--unknown"],
    ["pending", path, "--actor", "assistant", "--actor", "other"],
    ["reply", path, "thread-1", "--actor", "assistant", "--body-file", "-"],
    ["acknowledge", path, "--actor", "assistant", "--through", "3"],
    ["threads", path, "--status", "stale"],
    ["resolve", path, "thread-1", "--actor", "assistant", "--operation-id", "op", "--expected-thread-sequence", "0"],
  ]) {
    const result = await runCli(argv, { readBody: async () => { reads += 1; return "must not be read"; } });
    expect(result).toMatchObject({ exitCode: 2, response: { error: { code: "usage" } } });
  }
  expect(reads).toBe(0);
});

test("provides command-specific help without daemon work", async () => {
  const global = await runCli(["--help"]);
  expect(global).toMatchObject({ exitCode: 0, response: { ok: true, command: "help", data: { commands: expect.any(Array) } } });
  const command = await runCli(["acknowledge", "--help"]);
  expect(command).toEqual({
    exitCode: 0,
    response: {
      protocol: 1,
      ok: true,
      command: "help",
      data: {
        command: "acknowledge",
        usage: "mdreview acknowledge <file> --actor <actor> --cursor <cursor> --operation-id <id> [--consumer <consumer>]",
      },
    },
  });
});

test("creates a private comment from a server-resolved quote", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-comment-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "A quoted passage.\n");
  const config = resolveConfig({ profile: "comment", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const created = await runCli([
    "comment", path, "--actor", "assistant", "--quote", "quoted passage",
    "--body-file", "-", "--operation-id", "comment-1",
  ], { config, readBody: async () => "Please review this passage." });
  expect(created.response).toMatchObject({ ok: true, command: "comment", data: { mutation: { operationId: "comment-1", sequence: 1 } } });
  expect(await readFile(path, "utf8")).toBe("A quoted passage.\n");
  expect((await runCli(["threads", path, "--status", "open"], { config })).response).toMatchObject({ ok: true, command: "threads", data: { threads: [{ status: "open" }] } });
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

test("runs the private review workflow with cursors and retry-safe mutations", async () => {
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
    operationId: "seed-comment",
    expectedBodyRevision: initial.bodyRevision,
    body: "Please revise and explain.",
    anchor: { exact: "Review", prefix: "", suffix: " target", projectionStart: 0, projectionEnd: 6, bodyRevision: initial.bodyRevision },
  });
  daemon.service.close(seedGrant);
  const threadId = (seeded.annotations.events[0] as { id: string }).id;

  const read = await runCli(["document", "read", path], { config });
  expect(read.exitCode).toBe(0);
  expect(read.response).toMatchObject({ protocol: 1, ok: true, command: "document.read", data: { body: "Review target\n", bodyRevision: initial.bodyRevision } });

  const pending = await runCli(["pending", path, "--actor", "assistant"], { config });
  expect(pending.response).toMatchObject({ ok: true, command: "pending", data: { events: [{ id: threadId, type: "comment" }], maxSequence: 1 } });
  expect(JSON.stringify(pending.response)).not.toContain('"thread"');
  expect(JSON.stringify(pending.response)).not.toContain("Review target");
  const cursor = (pending.response as { data: { cursor: string } }).data.cursor;
  expect(typeof cursor).toBe("string");

  expect((await runCli(["thread", path, threadId], { config })).response).toMatchObject({ ok: true, command: "thread", data: { thread: { id: threadId, status: "open" } } });
  const replyArgs = ["reply", path, threadId, "--actor", "assistant", "--body-file", "-", "--operation-id", "reply-1"];
  const reply = await runCli(replyArgs, { config, readBody: async () => "Applied the requested revision.\nSecond line." });
  expect(reply.response).toMatchObject({ ok: true, command: "reply", data: { mutation: { operationId: "reply-1", sequence: 2, replayed: false } } });
  const replay = await runCli(replyArgs, { config, readBody: async () => "Applied the requested revision.\nSecond line." });
  expect(replay.response).toMatchObject({ ok: true, command: "reply", data: { mutation: { operationId: "reply-1", sequence: 2, replayed: true } } });
  expect((await runCli(["resolve", path, threadId, "--actor", "assistant", "--operation-id", "resolve-1", "--expected-thread-sequence", "2"], { config })).response).toMatchObject({ ok: true, command: "resolve", data: { mutation: { operationId: "resolve-1", sequence: 3 } } });

  expect(await readFile(path, "utf8")).toBe("Review target\n");
  const saved = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], {
    config,
    readBody: async () => "Revised by agent.\n\nMultiline body.\n",
  });
  expect(saved.response).toMatchObject({ ok: true, command: "document.save", data: { bodyRevision: bodyRevision("Revised by agent.\n\nMultiline body.\n"), ledgerRevision: expect.any(String) } });
  expect(await readFile(path, "utf8")).toBe("Revised by agent.\n\nMultiline body.\n");

  expect((await runCli(["acknowledge", path, "--actor", "assistant", "--cursor", cursor, "--operation-id", "ack-1"], { config })).response).toMatchObject({ ok: true, command: "acknowledge", data: { mutation: { operationId: "ack-1", sequence: 1, replayed: false } } });
  expect((await runCli(["pending", path, "--actor", "assistant"], { config })).response).toMatchObject({ ok: true, data: { events: [] } });

  const conflict = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], { config, readBody: async () => "Stale overwrite\n" });
  expect(conflict).toMatchObject({ exitCode: 1, response: { ok: false, command: "document.save", error: { code: "conflict" } } });
  const missing = await runCli(["document", "read", join(directory, "missing.md")], { config });
  expect(missing).toMatchObject({ exitCode: 1, response: { error: { code: "document_not_found" } } });
  const invalidThread = await runCli(["thread", path, "missing-thread"], { config });
  expect(invalidThread).toMatchObject({ exitCode: 1, response: { error: { code: "thread_not_found" } } });
});

test("literal help is a pathname and unsupported mutation consumers fail before input reads", async () => {
  let reads = 0;
  const literal = await runCli(["open", "--", "--help"]);
  expect(literal.response.command).toBe("open");
  expect(literal.response.ok).toBe(false);
  for (const action of ["reply", "resolve", "reopen", "edit", "delete"]) {
    const result = await runCli([action, "/tmp/doc.md", "thread", ...(["edit", "delete"].includes(action) ? ["target"] : []), "--actor", "assistant", "--operation-id", "op", "--consumer", "ignored", ...(["edit", "reply"].includes(action) ? ["--body-file", "-"] : [])], { readBody: async () => { reads++; return "body"; } });
    expect(result.exitCode).toBe(2);
  }
  expect(reads).toBe(0);
  expect((await runCli(["folio", "list", "--help"])).response).toMatchObject({ data: { usage: expect.stringContaining("--directory") } });
});

test("exports publish complete private files and require explicit overwrite", async () => {
  const { writeExport, readBoundedInput } = await import("../src/cli/io");
  const directory = await mkdtemp(join("/tmp", "tether-export-"));
  directories.push(directory);
  const output = join(directory, "review.tether");
  await writeFile(output, "original");
  await expect(writeExport(output, "replacement")).rejects.toMatchObject({ code: "destination_exists" });
  expect(await readFile(output, "utf8")).toBe("original");
  await writeExport(output, "replacement", true);
  expect(await readFile(output, "utf8")).toBe("replacement");
  await expect(readBoundedInput(output, 3)).rejects.toMatchObject({ code: "input_too_large" });
});

test("validates daemon success shapes instead of trusting JSON casts", async () => {
  const { validateControlResponse } = await import("../src/server/lifecycle");
  expect(validateControlResponse("/control/document/read", { body: "incomplete" })).toBe(false);
  expect(validateControlResponse("/control/review/pending", { events: [], cursor: 3, maxSequence: 0 })).toBe(false);
  expect(validateControlResponse("/control/launch", { url: "x", expiresAt: "tomorrow", path: "x" })).toBe(false);
  expect(validateControlResponse("/control/folio/export", { format: "tether-review", version: 1, documents: [] })).toBe(true);
  expect(validateControlResponse("/control/document/read", { path: "x", body: "", bodyRevision: "revision" })).toBe(true);
});

test("bounded reads and authoring commands expose only effective options", async () => {
  const { parseCommand, readOptions } = await import("../src/cli/commands");
  const page = parseCommand(["thread", "doc.md", "thread-1", "--limit", "3", "--max-bytes", "4096", "--continuation", "page"]);
  expect(readOptions(page)).toEqual({ limit: 3, maxBytes: 4096, continuation: "page" });
  expect(parseCommand(["document", "move", "old.md", "new.md"]).positionals).toEqual(["old.md", "new.md"]);
  expect(parseCommand(["edit", "doc.md", "thread", "reply", "--actor", "assistant", "--body-file", "-", "--operation-id", "edit-1"]).positionals).toEqual(["doc.md", "thread", "reply"]);
  expect(() => parseCommand(["document", "outline", "doc.md", "--max-bytes", "2"])).toThrow("between 2048 and 65536");
  expect(() => parseCommand(["comment", "doc.md", "--actor", "assistant", "--quote", "quote", "--body-file", "-", "--operation-id", "op", "--candidate-id", "candidate"])).toThrow("requires --expected-body-revision");
});
