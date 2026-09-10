import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CmuxBridgeError,
  cmuxBridgeHealthy,
  cmuxBridgeStatus,
  fingerprintCmuxSocket,
  openThroughCmuxBridge,
  openLocalFileThroughCmuxBridge,
  readCmuxBridge,
  removeCmuxBridge,
  startCmuxBridge,
  stopCmuxBridge,
  writeCmuxBridge,
} from "../src/hosts/cmux-bridge";
import { ensureControlToken, prepareConfig, resolveConfig, writeDiscovery } from "../src/server/config";
import { createBrowserHost } from "../src/hosts/browser";
import { HostGateway } from "../src/hosts/host-gateway";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT, SUPPORTED_CMUX_VERSION } from "../src/hosts/cmux";

const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const daemons: TetherDaemon[] = [];
const bridgeConfigs: ReturnType<typeof resolveConfig>[] = [];
const testSocketFingerprint = fingerprintCmuxSocket("/tmp/cmux-test.sock");

afterEach(async () => {
  for (const config of bridgeConfigs.splice(0)) await stopCmuxBridge(config).catch(() => {});
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(name: string) {
  const directory = await mkdtemp(join("/tmp", `tether-cmux-bridge-${name}-`));
  directories.push(directory);
  const config = resolveConfig({ profile: name, runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  await prepareConfig(config);
  const token = await ensureControlToken(config);
  return { config, token };
}

test("stores only non-secret cmux bridge discovery with private permissions", async () => {
  const { config } = await fixture("record");
  const record = {
    pid: process.pid,
    origin: "http://127.0.0.1:48123",
    instanceId: "bridge-one",
    daemonInstanceId: "daemon-one",
    cmuxVersion: SUPPORTED_CMUX_VERSION,
    cmuxBuild: SUPPORTED_CMUX_BUILD,
    cmuxCommit: SUPPORTED_CMUX_COMMIT,
    cmuxSocketFingerprint: testSocketFingerprint,
    startedAt: new Date().toISOString(),
  };
  await writeCmuxBridge(config, record);
  expect(await readCmuxBridge(config)).toEqual(record);
  expect((await stat(config.cmuxBridgePath)).mode & 0o077).toBe(0);
  const stored = await readFile(config.cmuxBridgePath, "utf8");
  expect(stored).not.toContain("capability");
  expect(stored).not.toContain("/tmp/cmux-test.sock");

  await removeCmuxBridge(config, "another-instance");
  expect(await readCmuxBridge(config)).toEqual(record);
  await removeCmuxBridge(config, record.instanceId);
  expect(await readCmuxBridge(config)).toBeNull();
});

test("authenticates bridge calls and preserves the complete open operation", async () => {
  const { config, token } = await fixture("request");
  await writeDiscovery(config, { protocol: 1, instanceId: "daemon-one", pid: process.pid, origin: "http://127.0.0.1:8420", startedAt: new Date().toISOString() });
  const received: Array<{ authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/health") return Response.json({
      service: "tether-cmux-bridge",
      instanceId: "bridge-one",
      daemonInstanceId: "daemon-one",
      cmuxVersion: SUPPORTED_CMUX_VERSION,
      cmuxBuild: SUPPORTED_CMUX_BUILD,
      cmuxCommit: SUPPORTED_CMUX_COMMIT,
      cmuxSocketFingerprint: testSocketFingerprint,
      cmuxReady: true,
    });
    received.push({ authorization: request.headers.get("authorization"), body: await request.json() });
    return Response.json({ opened: true, launchConsumed: false });
  } });
  servers.push(server);
  await writeCmuxBridge(config, {
    pid: process.pid,
    origin: `http://127.0.0.1:${server.port}`,
    instanceId: "bridge-one",
    daemonInstanceId: "daemon-one",
    cmuxVersion: SUPPORTED_CMUX_VERSION,
    cmuxBuild: SUPPORTED_CMUX_BUILD,
    cmuxCommit: SUPPORTED_CMUX_COMMIT,
    cmuxSocketFingerprint: testSocketFingerprint,
    startedAt: new Date().toISOString(),
  });
  const request = {
    url: "http://127.0.0.1:8420/launch?ticket=opaque",
    kind: "document" as const,
    focus: false,
    allowFocusedFallback: false,
    targetPolicy: "focused-workspace" as const,
    target: {
      host: "cmux",
      version: "0.64.22",
      build: String(SUPPORTED_CMUX_BUILD),
      commit: SUPPORTED_CMUX_COMMIT,
      windowId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      surfaceId: "33333333-3333-4333-8333-333333333333",
    },
  };
  expect(await openThroughCmuxBridge(config, request)).toEqual({ launchConsumed: false });
  const browserOpens: string[] = [];
  const gateway = new HostGateway(config, createBrowserHost({ open: async (url) => { browserOpens.push(url); } }));
  expect(await gateway.openView(request)).toEqual({ launchConsumed: false });
  expect(browserOpens).toEqual([]);
  expect(received).toEqual([
    { authorization: `Bearer ${token}`, body: request },
    { authorization: `Bearer ${token}`, body: request },
  ]);
  expect(await cmuxBridgeHealthy(config, "daemon-one")).toBe(true);
  expect(await cmuxBridgeStatus(config)).toMatchObject({ running: true, callbackPlacementReady: true, cmuxVersion: "0.64.22" });
  await writeDiscovery(config, { protocol: 1, instanceId: "daemon-two", pid: process.pid, origin: "http://127.0.0.1:8421", startedAt: new Date().toISOString() });
  expect(await cmuxBridgeStatus(config)).toMatchObject({
    running: true,
    callbackPlacementReady: false,
    issue: { code: "bridge_relaunch_required" },
  });
});

test("returns structured bridge errors without using another host", async () => {
  const { config } = await fixture("error");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ error: { code: "placement_anchor_missing", message: "Source surface is gone.", details: { surfaceId: "gone" } } }, { status: 409 });
  } });
  servers.push(server);
  await writeCmuxBridge(config, {
    pid: process.pid,
    origin: `http://127.0.0.1:${server.port}`,
    instanceId: "bridge-error",
    daemonInstanceId: "daemon-error",
    cmuxVersion: SUPPORTED_CMUX_VERSION,
    cmuxBuild: SUPPORTED_CMUX_BUILD,
    cmuxCommit: SUPPORTED_CMUX_COMMIT,
    cmuxSocketFingerprint: testSocketFingerprint,
    startedAt: new Date().toISOString(),
  });
  try {
    await openThroughCmuxBridge(config, { url: "http://127.0.0.1:1/launch?ticket=x", kind: "document", focus: false });
    throw new Error("Expected bridge error.");
  } catch (cause) {
    expect(cause).toBeInstanceOf(CmuxBridgeError);
    expect(cause).toMatchObject({ code: "placement_anchor_missing", status: 409, details: { surfaceId: "gone" } });
  }
});

test("routes cmux targets through the bridge without browser fallback", async () => {
  const { config } = await fixture("gateway");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ error: { code: "bridge_relaunch_required", message: "Relaunch from cmux." } }, { status: 503 });
  } });
  servers.push(server);
  await writeCmuxBridge(config, {
    pid: process.pid,
    origin: `http://127.0.0.1:${server.port}`,
    instanceId: "bridge-gateway",
    daemonInstanceId: "daemon-gateway",
    cmuxVersion: SUPPORTED_CMUX_VERSION,
    cmuxBuild: SUPPORTED_CMUX_BUILD,
    cmuxCommit: SUPPORTED_CMUX_COMMIT,
    cmuxSocketFingerprint: testSocketFingerprint,
    startedAt: new Date().toISOString(),
  });
  const browserOpens: string[] = [];
  const gateway = new HostGateway(config, createBrowserHost({ open: async (url) => { browserOpens.push(url); } }));
  const target = {
    host: "cmux",
    version: "0.64.22",
    build: String(SUPPORTED_CMUX_BUILD),
    commit: SUPPORTED_CMUX_COMMIT,
    windowId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    surfaceId: "33333333-3333-4333-8333-333333333333",
  };
  expect(gateway.capabilities(target)).toMatchObject({ embeddedBrowser: true, widgetInstallation: false, fileNavigatorHook: false });
  expect(gateway.capabilities({ ...target, build: String(SUPPORTED_CMUX_BUILD + 1) })).toMatchObject({ embeddedBrowser: false });
  await expect(gateway.openView({ url: "http://127.0.0.1:8420/launch?ticket=x", kind: "document", focus: true, target })).rejects.toMatchObject({ code: "bridge_relaunch_required" });
  expect(browserOpens).toEqual([]);
});

test("requires the inherited signed cmux capability to bootstrap callbacks", async () => {
  const { config } = await fixture("bootstrap");
  await expect(startCmuxBridge(config, { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).rejects.toMatchObject({
    code: "bridge_bootstrap_unsupported",
  });
  expect(await cmuxBridgeStatus(config)).toMatchObject({
    running: false,
    callbackPlacementReady: false,
    issue: { code: "bridge_relaunch_required" },
  });
});

test("rejects an unsupported exact cmux build before spawning a bridge", async () => {
  const { config } = await fixture("unsupported-build");
  await writeDiscovery(config, { protocol: 1, instanceId: "daemon-build", pid: process.pid, origin: "http://127.0.0.1:8422", startedAt: new Date().toISOString() });
  const directory = join(config.runtimeDir, "bin");
  await mkdir(directory);
  const executable = join(directory, "cmux");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'cmux ${SUPPORTED_CMUX_VERSION} (${SUPPORTED_CMUX_BUILD + 1}) [${SUPPORTED_CMUX_COMMIT}]'; else echo '{}'; fi
`);
  await chmod(executable, 0o700);
  await expect(startCmuxBridge(config, {
    PATH: `${directory}:/usr/bin:/bin`,
    CMUX_SOCKET_PATH: "/tmp/cmux-unsupported.sock",
    CMUX_SOCKET_CAPABILITY: "in-memory-only",
    CMUX_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222",
    CMUX_SURFACE_ID: "33333333-3333-4333-8333-333333333333",
  })).rejects.toMatchObject({ code: "unsupported_version", status: 400 });
  expect(await readCmuxBridge(config)).toBeNull();
});

test("runs callback placement through a detached capability-retaining bridge", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cmux-bridge-process-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "process", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const ids = {
    window: "11111111-1111-4111-8111-111111111111",
    workspace: "22222222-2222-4222-8222-222222222222",
    surface: "33333333-3333-4333-8333-333333333333",
    pane: "44444444-4444-4444-8444-444444444444",
    created: "55555555-5555-4555-8555-555555555555",
  };
  const bin = join(directory, "bin");
  const log = join(directory, "cmux.log");
  const versionFile = join(directory, "cmux-version.txt");
  const executable = join(bin, "cmux");
  await mkdir(bin);
  await writeFile(versionFile, `cmux ${SUPPORTED_CMUX_VERSION} (${SUPPORTED_CMUX_BUILD}) [${SUPPORTED_CMUX_COMMIT}]\n`);
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *--version*) /bin/cat '${versionFile}' ;;
  *identify*) echo '{"caller":{"window_id":"${ids.window}","workspace_id":"${ids.workspace}","surface_id":"${ids.surface}","surface_type":"terminal"}}' ;;
  *tree*) echo '{"windows":[{"id":"${ids.window}","workspaces":[{"id":"${ids.workspace}","panes":[{"id":"${ids.pane}","surfaces":[{"id":"${ids.surface}","type":"terminal","title":"shell"}]}]}]}]}' ;;
  *'rpc browser.open_split'*) echo '{"window_id":"${ids.window}","workspace_id":"${ids.workspace}","source_pane_id":"${ids.pane}","target_pane_id":"${ids.pane}","surface_id":"${ids.created}","created_split":true,"placement_strategy":"split_right","show_omnibar":false}' ;;
  *rename-tab*) echo '{"surface_id":"${ids.created}"}' ;;
  *ping*) echo 'PONG' ;;
  *) echo '{}' ;;
esac
`);
  await chmod(executable, 0o700);

  bridgeConfigs.push(config);
  const bridgeEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: process.env.TMPDIR,
    CMUX_SOCKET_PATH: join(directory, "cmux.sock"),
    CMUX_SOCKET_CAPABILITY: "in-memory-only",
    CMUX_WORKSPACE_ID: ids.workspace,
    CMUX_SURFACE_ID: ids.surface,
  };
  const buildOptions = { cmuxVersion: SUPPORTED_CMUX_VERSION, cmuxBuild: SUPPORTED_CMUX_BUILD, cmuxCommit: SUPPORTED_CMUX_COMMIT };
  const started = await Promise.all([
    startCmuxBridge(config, bridgeEnv, buildOptions),
    startCmuxBridge(config, bridgeEnv, buildOptions),
  ]);
  expect(started[0]?.instanceId).toBe(started[1]?.instanceId);
  const firstRecord = await readCmuxBridge(config);
  expect(firstRecord?.cmuxSocketFingerprint).toBe(fingerprintCmuxSocket(bridgeEnv.CMUX_SOCKET_PATH));

  const replacementSocket = join(directory, "another-cmux.sock");
  await startCmuxBridge(config, { ...bridgeEnv, CMUX_SOCKET_PATH: replacementSocket }, buildOptions);
  const replacementRecord = await readCmuxBridge(config);
  expect(replacementRecord?.instanceId).not.toBe(firstRecord?.instanceId);
  expect(replacementRecord?.cmuxSocketFingerprint).toBe(fingerprintCmuxSocket(replacementSocket));

  const recordText = await readFile(config.cmuxBridgePath, "utf8");
  expect(recordText).not.toContain("in-memory-only");
  expect(recordText).not.toContain(replacementSocket);
  expect((await fetch(`${replacementRecord!.origin}/health`)).status).toBe(401);
  await openThroughCmuxBridge(config, {
    url: `${daemon.origin}/launch?ticket=opaque`,
    kind: "document",
    focus: false,
    allowFocusedFallback: false,
    target: { host: "cmux", version: "0.64.22", build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.surface },
  });
  // Replace the fake host's live tree with a reader; the bridge must forward
  // source-pane placement and native local-file requests without losing context.
  const readerUrl = `${daemon.origin}/s/source-reader/`;
  const executableBody = await readFile(executable, "utf8");
  await writeFile(executable, executableBody.replace('"type":"terminal","title":"shell"', `"type":"browser","url":"${readerUrl}"`));
  const target = { host: "cmux", version: "0.64.22", build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.surface };
  await openThroughCmuxBridge(config, { url: `${daemon.origin}/launch?ticket=linked`, kind: "document", focus: true,
    targetPolicy: "source-pane", sourceUrl: readerUrl, target });
  await openLocalFileThroughCmuxBridge(config, { path: "/tmp/transcript with spaces.txt", sourceUrl: readerUrl, target });
  await expect(openLocalFileThroughCmuxBridge(config, { path: "/tmp/transcript.txt", sourceUrl: "https://example.com/s/reader/", target })).rejects.toMatchObject({ code: "invalid_target" });
  const commands = await readFile(log, "utf8");
  expect(commands).toContain("tree --all");
  expect(commands).toContain("open /tmp/transcript with spaces.txt");
  expect(commands).toContain("ping");
  expect(commands).toContain("rpc browser.open_split");
  expect(commands).toContain('"show_omnibar":false');
  expect(commands).not.toContain("rename-tab");
  expect(commands).not.toContain("in-memory-only");
  await expect(openThroughCmuxBridge(config, {
    url: "https://example.com/launch?ticket=opaque",
    kind: "document",
    focus: true,
    target: { host: "cmux", version: "0.64.22", build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.surface },
  })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  await writeFile(versionFile, `cmux ${SUPPORTED_CMUX_VERSION} (${SUPPORTED_CMUX_BUILD + 1}) [${SUPPORTED_CMUX_COMMIT}]\n`);
  expect(await cmuxBridgeStatus(config)).toMatchObject({
    running: true,
    callbackPlacementReady: false,
    issue: { code: "unsupported_version" },
  });
  await expect(openThroughCmuxBridge(config, {
    url: `${daemon.origin}/launch?ticket=still-valid-shape`,
    kind: "document",
    focus: false,
    target: { host: "cmux", version: "0.64.22", build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.surface },
  })).rejects.toMatchObject({ code: "unsupported_version", status: 400 });
});
