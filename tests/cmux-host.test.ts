import { expect, test } from "bun:test";
import {
  CmuxHostAdapter,
  CmuxHostError,
  SUPPORTED_CMUX_BUILD,
  SUPPORTED_CMUX_COMMIT,
  SUPPORTED_CMUX_VERSION,
  TETHER_RECENTS_TAB_TITLE,
  TETHER_REVIEW_TAB_TITLE,
  type CmuxCommandResult,
} from "../src/hosts/cmux";

const versionOutput = `cmux ${SUPPORTED_CMUX_VERSION} (${SUPPORTED_CMUX_BUILD}) [${SUPPORTED_CMUX_COMMIT}]`;
const daemonInstanceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const ids = {
  window: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  source: "33333333-3333-4333-8333-333333333333",
  sourcePane: "44444444-4444-4444-8444-444444444444",
  reviewPane: "55555555-5555-4555-8555-555555555555",
  reviewSurface: "66666666-6666-4666-8666-666666666666",
  createdSurface: "77777777-7777-4777-8777-777777777777",
  dockPane: "88888888-8888-4888-8888-888888888888",
  dockSurface: "99999999-9999-4999-8999-999999999999",
  otherWindow: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherWorkspace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  otherSurface: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  otherPane: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

const env = {
  CMUX_WORKSPACE_ID: ids.workspace,
  CMUX_SURFACE_ID: ids.source,
  CMUX_SOCKET_PATH: "/tmp/cmux.sock",
  CMUX_SOCKET_CAPABILITY: "memory-only-capability",
  UNRELATED_SECRET: "do-not-pass",
};

const ok = (value: unknown): CmuxCommandResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
const openSplit = (overrides: Record<string, unknown> = {}) => ({
  window_id: ids.window,
  workspace_id: ids.workspace,
  source_pane_id: ids.sourcePane,
  target_pane_id: ids.reviewPane,
  surface_id: ids.createdSurface,
  created_split: true,
  placement_strategy: "split_right",
  show_omnibar: false,
  ...overrides,
});
const placement = (paneId: string, overrides: Record<string, unknown> = {}) => ({
  window_id: ids.window,
  workspace_id: ids.workspace,
  surface_id: ids.createdSurface,
  pane_id: paneId,
  ...overrides,
});
const identity = {
  caller: { window_id: ids.window, workspace_id: ids.workspace, surface_id: ids.source, surface_type: "terminal" },
  focused: { window_id: ids.window, workspace_id: ids.workspace, surface_id: ids.source, surface_type: "terminal" },
};
const tree = (extraPanes: unknown[] = []) => ({
  windows: [{ id: ids.window, workspaces: [{ id: ids.workspace, panes: [
    { id: ids.sourcePane, surfaces: [{ id: ids.source, type: "terminal", title: "shell" }] },
    ...extraPanes,
  ] }] }],
});

function adapter(run: (command: string[], commandEnv: NodeJS.ProcessEnv) => Promise<CmuxCommandResult>) {
  return new CmuxHostAdapter({
    env,
    cmuxPath: "cmux",
    run,
    fetch: async () => Response.json({ service: "tether", protocol: 1, instanceId: daemonInstanceId }),
    externalHost: { openExternal: async () => {}, revealFile: async () => {} },
  });
}

async function detected(run: (command: string[], commandEnv: NodeJS.ProcessEnv) => Promise<CmuxCommandResult>) {
  const host = adapter(run);
  expect(await host.detect()).toBe(true);
  return host;
}

test("detects the supported build, captures immutable IDs, and sanitizes command environment", async () => {
  const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const host = await detected(async (command, commandEnv) => {
    calls.push({ command, env: commandEnv });
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    return ok(identity);
  });
  expect(host.capabilities()).toEqual({ embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true });
  expect([host.detectedVersion(), host.detectedBuild(), host.detectedCommit()]).toEqual([SUPPORTED_CMUX_VERSION, SUPPORTED_CMUX_BUILD, SUPPORTED_CMUX_COMMIT]);
  expect(host.launchTarget()).toEqual({ host: "cmux", version: SUPPORTED_CMUX_VERSION, build: String(SUPPORTED_CMUX_BUILD), commit: SUPPORTED_CMUX_COMMIT, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.source });
  expect(calls[1]?.command).toEqual(["cmux", "--json", "--id-format", "uuids", "identify", "--workspace", ids.workspace, "--surface", ids.source]);
  expect(calls[1]?.env.CMUX_SOCKET_CAPABILITY).toBe("memory-only-capability");
  expect(calls[1]?.env.UNRELATED_SECRET).toBeUndefined();
});

test("rejects a matching version with the wrong build or commit", async () => {
  for (const output of [`cmux ${SUPPORTED_CMUX_VERSION} (101) [${SUPPORTED_CMUX_COMMIT}]`, `cmux ${SUPPORTED_CMUX_VERSION} (${SUPPORTED_CMUX_BUILD}) [fffffffff]`]) {
    const host = adapter(async (command) => command.includes("--version") ? { exitCode: 0, stdout: output, stderr: "" } : ok(identity));
    expect(await host.detect()).toBe(true);
    expect(host.capabilities().embeddedBrowser).toBe(false);
    await expect(host.openView({ url: "http://127.0.0.1:8420/launch?ticket=x", kind: "document", focus: true, target: { host: "cmux", version: SUPPORTED_CMUX_VERSION, windowId: ids.window, workspaceId: ids.workspace, surfaceId: ids.source } })).rejects.toMatchObject({ code: "unsupported_version" });
  }
});

test("rejects immutable targets without the exact supported build identity", async () => {
  const host = await detected(async (command) => command.includes("--version")
    ? { exitCode: 0, stdout: versionOutput, stderr: "" }
    : ok(identity));
  const target = { ...host.launchTarget()!, build: "101" };
  await expect(host.openView({ url: "http://127.0.0.1:8420/launch?ticket=x", kind: "document", focus: true, target })).rejects.toMatchObject({ code: "unsupported_version" });
});

test("keeps host detection separate from socket readiness", async () => {
  const host = adapter(async (command) => {
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "Failed to connect to socket" };
  });
  expect(await host.detect()).toBe(true);
  expect(host.launchTarget()).toBeUndefined();
  await expect(host.probeSocket()).rejects.toMatchObject({ code: "socket_unavailable" });
});

test("returns false when the cmux executable cannot be started", async () => {
  const host = adapter(async () => { throw new Error("ENOENT"); });
  expect(await host.detect()).toBe(false);
});

test("creates the first review browser beside the exact captured surface without an omnibar", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit());
    return ok({ action: "rename", surface_id: ids.createdSurface });
  });
  await host.openView({ url: "http://127.0.0.1:8420/launch?ticket=one", kind: "document", focus: false, target: host.launchTarget() });
  const rpc = commands.find((command) => command.includes("rpc"))!;
  expect(rpc.slice(1, -1)).toEqual(["--json", "--id-format", "both", "rpc", "browser.open_split"]);
  expect(JSON.parse(rpc.at(-1)!)).toEqual({ window_id: ids.window, workspace_id: ids.workspace, surface_id: ids.source, focus: false, show_omnibar: false });
  const renameIndex = commands.findIndex((command) => command.includes("rename-tab"));
  const navigateIndex = commands.findIndex((command) => command.includes("navigate"));
  expect(renameIndex).toBeGreaterThan(commands.indexOf(rpc));
  expect(navigateIndex).toBeGreaterThan(renameIndex);
  expect(commands[navigateIndex]).toContain("http://127.0.0.1:8420/launch?ticket=one");
});

test("isolates the first chromeless review when cmux reuses a right sibling pane", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit({ created_split: false, placement_strategy: "reuse_right_sibling" }));
    if (command.includes("split-off")) return ok(placement(ids.otherPane));
    return ok({ surface_id: ids.createdSurface });
  });
  await host.openView({ url: "http://127.0.0.1:8420/reused", kind: "document", focus: true, target: host.launchTarget() });
  expect(JSON.parse(commands.find((command) => command.includes("browser.open_split"))!.at(-1)!)).toMatchObject({ focus: false, show_omnibar: false });
  const splitOff = commands.find((command) => command.includes("split-off"))!;
  expect(splitOff).toEqual([
    "cmux", "--json", "--id-format", "both", "split-off", "--surface", ids.createdSurface, "right",
    "--workspace", ids.workspace, "--window", ids.window, "--focus", "false",
  ]);
  const renameIndex = commands.findIndex((command) => command.includes("rename-tab"));
  const focusIndex = commands.findIndex((command) => command.includes("focus-panel"));
  const navigateIndex = commands.findIndex((command) => command.includes("navigate"));
  expect(renameIndex).toBeGreaterThan(commands.indexOf(splitOff));
  expect(navigateIndex).toBeGreaterThan(renameIndex);
  expect(focusIndex).toBeGreaterThan(navigateIndex);
});

test("discovers one live review pane and adds later documents there without an omnibar", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] }]));
    if (command.includes("rpc")) return ok(openSplit({ created_split: false, placement_strategy: "reuse_right_sibling" }));
    return ok({ action: "rename" });
  });
  await host.openView({ url: "http://127.0.0.1:8420/launch?ticket=two", kind: "document", focus: false, target: host.launchTarget() });
  const create = commands.find((command) => command.includes("rpc"))!;
  expect(JSON.parse(create.at(-1)!)).toMatchObject({ surface_id: ids.source, focus: false, show_omnibar: false });
  expect(commands.some((command) => command.includes("move-surface"))).toBe(false);
  expect(commands.findIndex((command) => command.includes("navigate"))).toBeGreaterThan(commands.findIndex((command) => command.includes("rename-tab")));
});

test("moves a newly hidden browser into the discovered review pane when cmux places it elsewhere", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] }]));
    if (command.includes("rpc")) return ok(openSplit({ target_pane_id: ids.otherPane }));
    if (command.includes("move-surface")) return ok(placement(ids.reviewPane));
    return ok({ surface_id: ids.createdSurface });
  });
  await host.openView({ url: "http://127.0.0.1:8420/moved", kind: "document", focus: false, target: host.launchTarget() });
  const move = commands.find((command) => command.includes("move-surface"))!;
  expect(move).toEqual([
    "cmux", "--json", "--id-format", "both", "move-surface", "--surface", ids.createdSurface,
    "--pane", ids.reviewPane, "--workspace", ids.workspace, "--window", ids.window, "--focus", "false",
  ]);
  expect(commands.findIndex((command) => command.includes("rename-tab"))).toBeGreaterThan(commands.indexOf(move));
});

test("rejects and closes a browser when cmux does not confirm hidden chrome", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit({ show_omnibar: true }));
    return ok({ closed: true });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/chrome", kind: "document", focus: false, target: host.launchTarget() })).rejects.toMatchObject({ code: "invalid_response" });
  expect(commands.some((command) => command.includes("close-surface") && command.includes(ids.createdSurface))).toBe(true);
  expect(commands.some((command) => command.includes("navigate"))).toBe(false);
});

test("closes an uninitialized browser when review-pane isolation or relocation fails", async () => {
  for (const scenario of [
    { name: "split-off", existingReview: false, targetPaneId: ids.reviewPane },
    { name: "move-surface", existingReview: true, targetPaneId: ids.otherPane },
  ]) {
    const commands: string[][] = [];
    const host = await detected(async (command) => {
      commands.push(command);
      if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
      if (command.includes("identify")) return ok(identity);
      if (command.includes("tree")) return ok(tree(scenario.existingReview
        ? [{ id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] }]
        : []));
      if (command.includes("rpc")) return ok(openSplit({
        target_pane_id: scenario.targetPaneId,
        created_split: scenario.existingReview,
        placement_strategy: scenario.existingReview ? "split_right" : "reuse_right_sibling",
      }));
      if (command.includes(scenario.name)) return { exitCode: 1, stdout: "", stderr: `${scenario.name} failed` };
      return ok({ closed: true });
    });
    await expect(host.openView({ url: `http://127.0.0.1:8420/${scenario.name}`, kind: "document", focus: true, target: host.launchTarget() })).rejects.toMatchObject({ code: "command_failed" });
    expect(commands.filter((command) => command.includes("close-surface"))).toHaveLength(1);
    expect(commands.some((command) => command.includes("rename-tab") || command.includes("focus-panel") || command.includes("navigate"))).toBe(false);
  }
});

test("rejects mismatched placement handles before consuming the launch URL", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit({ created_split: false, placement_strategy: "reuse_right_sibling" }));
    if (command.includes("split-off")) return ok(placement(ids.otherPane, { workspace_id: ids.otherWorkspace }));
    return ok({ closed: true });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/mismatch", kind: "document", focus: false, target: host.launchTarget() })).rejects.toMatchObject({ code: "invalid_response" });
  expect(commands.filter((command) => command.includes("close-surface"))).toHaveLength(1);
  expect(commands.some((command) => command.includes("rename-tab") || command.includes("navigate"))).toBe(false);
});

test("does not guess when live review-pane discovery is ambiguous", async () => {
  const host = await detected(async (command) => {
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    return ok(tree([
      { id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] },
      { id: ids.dockPane, surfaces: [{ id: ids.createdSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] },
    ]));
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/launch?ticket=x", kind: "document", focus: true, target: host.launchTarget() })).rejects.toMatchObject({ code: "ambiguous_review_pane" });
});

test("validates a missing source before review-pane reuse and allows same-workspace foreground fallback", async () => {
  let treeReads = 0;
  const commands: string[][] = [];
  const focused = { ...identity, focused: { window_id: ids.window, workspace_id: ids.workspace, surface_id: ids.otherSurface } };
  const fallbackTree = { windows: [{ id: ids.window, workspaces: [{ id: ids.workspace, panes: [
    { id: ids.otherPane, surfaces: [{ id: ids.otherSurface, type: "terminal", title: "focused" }] },
    { id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] },
  ] }] }] };
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(command.includes("--no-caller") ? focused : identity);
    if (command.includes("tree")) { treeReads++; return ok(fallbackTree); }
    if (command.includes("rpc")) return ok(openSplit({ created_split: false, placement_strategy: "reuse_right_sibling" }));
    return ok({ action: "rename" });
  });
  const target = host.launchTarget()!;
  await expect(host.openView({ url: "http://127.0.0.1:8420/a", kind: "document", focus: false, allowFocusedFallback: false, target })).rejects.toMatchObject({ code: "placement_anchor_missing" });
  expect(commands.some((command) => command.includes("rpc"))).toBe(false);
  await host.openView({ url: "http://127.0.0.1:8420/b", kind: "document", focus: true, allowFocusedFallback: true, target });
  const create = [...commands].reverse().find((command) => command.includes("rpc"))!;
  expect(JSON.parse(create.at(-1)!)).toMatchObject({ workspace_id: ids.workspace, surface_id: ids.otherSurface, show_omnibar: false });
  expect(treeReads).toBe(3);
});

test("foreground fallback follows global focus into another workspace and reuses its review pane", async () => {
  const commands: string[][] = [];
  const focused = { focused: { window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface } };
  const otherTree = { windows: [{ id: ids.otherWindow, workspaces: [{ id: ids.otherWorkspace, panes: [
    { id: ids.otherPane, surfaces: [{ id: ids.otherSurface, type: "terminal", title: "focused" }] },
    { id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] },
  ] }] }] };
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(command.includes("--no-caller") ? focused : identity);
    if (command.includes("tree")) return ok(command.includes(ids.otherWorkspace) ? otherTree : { windows: [{ id: ids.window, workspaces: [{ id: ids.workspace, panes: [] }] }] });
    if (command.includes("rpc")) return ok(openSplit({
      window_id: ids.otherWindow,
      workspace_id: ids.otherWorkspace,
      created_split: false,
      placement_strategy: "reuse_right_sibling",
    }));
    return ok({ action: "rename" });
  });
  await host.openView({ url: "http://127.0.0.1:8420/cross", kind: "document", focus: true, allowFocusedFallback: true, target: host.launchTarget() });
  const create = commands.find((command) => command.includes("rpc"))!;
  expect(JSON.parse(create.at(-1)!)).toMatchObject({ window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface, show_omnibar: false });
});

test("foreground fallback recovers when the original workspace vanished", async () => {
  const commands: string[][] = [];
  const focused = { focused: { window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface } };
  const otherTree = { windows: [{ id: ids.otherWindow, workspaces: [{ id: ids.otherWorkspace, panes: [{ id: ids.otherPane, surfaces: [{ id: ids.otherSurface, type: "terminal" }] }] }] }] };
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(command.includes("--no-caller") ? focused : identity);
    if (command.includes("tree") && command.includes(ids.workspace)) return { exitCode: 1, stdout: "", stderr: "Workspace not found" };
    if (command.includes("tree")) return ok(otherTree);
    if (command.includes("rpc")) return ok(openSplit({ window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, target_pane_id: ids.otherPane }));
    return ok({ action: "rename" });
  });
  await host.openView({ url: "http://127.0.0.1:8420/missing", kind: "document", focus: true, allowFocusedFallback: true, target: host.launchTarget() });
  const rpc = commands.find((command) => command.includes("rpc"))!;
  expect(JSON.parse(rpc.at(-1)!)).toMatchObject({ window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface });
});

test("foreground fallback recovers when the original window vanished", async () => {
  const commands: string[][] = [];
  const focused = { focused: { window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface } };
  const otherTree = { windows: [{ id: ids.otherWindow, workspaces: [{ id: ids.otherWorkspace, panes: [{ id: ids.otherPane, surfaces: [{ id: ids.otherSurface, type: "terminal" }] }] }] }] };
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(command.includes("--no-caller") ? focused : identity);
    if (command.includes("tree") && command.includes(ids.window)) return { exitCode: 1, stdout: "", stderr: "Window not found" };
    if (command.includes("tree")) return ok(otherTree);
    if (command.includes("rpc")) return ok(openSplit({ window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, target_pane_id: ids.otherPane }));
    return ok({ action: "rename" });
  });
  await host.openView({ url: "http://127.0.0.1:8420/window-missing", kind: "document", focus: true, allowFocusedFallback: true, target: host.launchTarget() });
  expect(JSON.parse(commands.find((command) => command.includes("rpc"))!.at(-1)!)).toMatchObject({ window_id: ids.otherWindow, workspace_id: ids.otherWorkspace, surface_id: ids.otherSurface });
});

test("creates blank and focuses Recents in Dock without treating its surface as a tab", async () => {
  const commands: string[][] = [];
  let hasRecents = false;
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree(hasRecents ? [{ id: ids.dockPane, dock_scope: "global", surfaces: [{ id: ids.dockSurface, type: "browser", title: TETHER_RECENTS_TAB_TITLE }] }] : []));
    if (command.includes("new-surface")) { hasRecents = true; return ok({ dock_pane_id: ids.dockPane, dock_surface_id: ids.dockSurface, pane_id: null, surface_id: null }); }
    return ok({ surface_id: ids.dockSurface });
  });
  const target = host.launchTarget();
  expect(await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=one", kind: "recents", focus: true, target })).toEqual({ launchConsumed: true });
  const dockCreate = commands.find((command) => command.includes("new-surface"))!;
  expect(dockCreate).toContain("dock");
  expect(dockCreate).not.toContain("--url");
  expect(commands.some((command) => command.includes("rename-tab") && command.includes(ids.dockSurface))).toBe(false);
  expect(commands.some((command) => command.includes("navigate") && command.includes(ids.dockSurface))).toBe(true);
  expect(commands.some((command) => command.includes("right-sidebar") && command.includes("--no-focus"))).toBe(true);
  expect(commands.some((command) => command.includes("focus-panel") && command.includes(ids.dockSurface))).toBe(true);
  commands.length = 0;
  expect(await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=two", kind: "recents", focus: false, target })).toEqual({ launchConsumed: true });
  expect(commands.some((command) => command.includes("navigate") && command.includes(ids.dockSurface))).toBe(true);
  expect(commands.some((command) => command.includes("right-sidebar") || command.includes("focus-panel"))).toBe(false);
});

test("reveals a retained live Recents session without consuming the new launch ticket", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.dockPane, dock_scope: "global", surfaces: [{
      id: ids.dockSurface,
      type: "browser",
      title: TETHER_RECENTS_TAB_TITLE,
      url: `http://127.0.0.1:8420/r/live-session/?instance=${daemonInstanceId}`,
    }] }]));
    return ok({ surface_id: ids.dockSurface });
  });
  const result = await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=unused", kind: "recents", focus: true, target: host.launchTarget() });
  expect(result).toEqual({ launchConsumed: false });
  expect(commands.some((command) => command.includes("navigate"))).toBe(false);
  expect(commands.some((command) => command.includes("right-sidebar"))).toBe(true);
  expect(commands.some((command) => command.includes("focus-panel"))).toBe(true);
});

test("navigates previous-daemon Recents once, then retains it on reruns", async () => {
  const commands: string[][] = [];
  let url = "http://127.0.0.1:8420/r/stale-session/?instance=previous-daemon";
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.dockPane, dock_scope: "global", surfaces: [{
      id: ids.dockSurface,
      type: "browser",
      title: TETHER_RECENTS_TAB_TITLE,
      url,
    }] }]));
    if (command.includes("rename-tab") && command.includes(ids.dockSurface)) throw new Error("Dock IDs are not tab IDs");
    if (command.includes("navigate")) { url = `http://127.0.0.1:8420/r/current-session/?instance=${daemonInstanceId}`; return ok({ surface_id: ids.dockSurface }); }
    return ok({ surface_id: ids.dockSurface });
  });
  const target = host.launchTarget();
  expect(await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=fresh", kind: "recents", focus: false, target })).toEqual({ launchConsumed: true });
  expect(await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=unused", kind: "recents", focus: false, target })).toEqual({ launchConsumed: false });
  expect(commands.filter((command) => command.includes("navigate"))).toHaveLength(1);
  expect(commands.filter((command) => command.includes("rename-tab") && command.includes(ids.dockSurface))).toHaveLength(0);
});

test("leaves an existing stale Recents surface undisguised when navigation fails", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.dockPane, dock_scope: "global", surfaces: [{
      id: ids.dockSurface, type: "browser", title: TETHER_RECENTS_TAB_TITLE, url: "http://127.0.0.1:8420/r/stale-session/?instance=previous-daemon",
    }] }]));
    if (command.includes("navigate")) return { exitCode: 1, stdout: "", stderr: "navigation failed" };
    return ok({ surface_id: ids.dockSurface });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=fresh", kind: "recents", focus: false, target: host.launchTarget() })).rejects.toMatchObject({ code: "command_failed" });
  expect(commands.some((command) => command.includes("rename-tab") && command.includes(ids.dockSurface))).toBe(false);
  expect(commands.some((command) => command.includes("close-surface"))).toBe(false);
});

test("navigates a retained Recents surface from a stale daemon origin", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree([{ id: ids.dockPane, dock_scope: "global", surfaces: [{
      id: ids.dockSurface,
      type: "browser",
      title: TETHER_RECENTS_TAB_TITLE,
      url: "http://127.0.0.1:9000/r/stale-session/",
    }] }]));
    return ok({ surface_id: ids.dockSurface });
  });
  const result = await host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=fresh", kind: "recents", focus: false, target: host.launchTarget() });
  expect(result).toEqual({ launchConsumed: true });
  expect(commands.some((command) => command.includes("navigate"))).toBe(true);
});

test("serializes concurrent placement per workspace so the second open can reuse live state", async () => {
  const commands: string[][] = [];
  let reviewCreated = false;
  let treeReads = 0;
  let releaseFirstTree!: () => void;
  const firstTreeGate = new Promise<void>((resolve) => { releaseFirstTree = resolve; });
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) {
      treeReads++;
      if (treeReads === 1) await firstTreeGate;
      return ok(tree(reviewCreated ? [{ id: ids.reviewPane, surfaces: [{ id: ids.reviewSurface, type: "browser", title: TETHER_REVIEW_TAB_TITLE }] }] : []));
    }
    if (command.includes("rpc")) {
      const createdSplit = !reviewCreated;
      reviewCreated = true;
      return ok(openSplit({ created_split: createdSplit, placement_strategy: createdSplit ? "split_right" : "reuse_right_sibling" }));
    }
    return ok({ action: "rename" });
  });
  const target = host.launchTarget();
  const first = host.openView({ url: "http://127.0.0.1:8420/one", kind: "document", focus: false, target });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = host.openView({ url: "http://127.0.0.1:8420/two", kind: "document", focus: false, target });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(treeReads).toBe(1);
  releaseFirstTree();
  await Promise.all([first, second]);
  expect(commands.filter((command) => command.includes("rpc"))).toHaveLength(2);
  expect(commands.filter((command) => command.includes("new-surface"))).toHaveLength(0);
});

test("closes a newly created review surface when stable naming fails", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit());
    if (command.includes("rename-tab")) return { exitCode: 1, stdout: "", stderr: "rename failed" };
    return ok({ closed: true });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/name-failure", kind: "document", focus: false, target: host.launchTarget() })).rejects.toMatchObject({ code: "command_failed" });
  const close = commands.find((command) => command.includes("close-surface"))!;
  expect(close).toContain(ids.createdSurface);
  expect(commands.find((command) => command.includes("rename-tab"))?.at(-1)).toBe(TETHER_REVIEW_TAB_TITLE);
});

test("never passes a Dock surface ID to rename-tab", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("new-surface")) return ok({ dock_surface_id: ids.dockSurface });
    if (command.includes("rename-tab") && command.includes(ids.dockSurface)) return { exitCode: 1, stdout: "", stderr: "not_found: Tab not found" };
    return ok({ surface_id: ids.dockSurface });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=dock-id", kind: "recents", focus: false, target: host.launchTarget() })).resolves.toEqual({ launchConsumed: true });
  expect(commands.some((command) => command.includes("rename-tab") && command.includes(ids.dockSurface))).toBe(false);
});

test("closes a newly created review surface without changing focus when navigation fails", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("rpc")) return ok(openSplit());
    if (command.includes("navigate")) return { exitCode: 1, stdout: "", stderr: "navigation failed" };
    return ok({ surface_id: ids.createdSurface });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/navigation-failure", kind: "document", focus: true, target: host.launchTarget() })).rejects.toMatchObject({ code: "command_failed" });
  const renameIndex = commands.findIndex((command) => command.includes("rename-tab"));
  const navigateIndex = commands.findIndex((command) => command.includes("navigate"));
  const closeIndex = commands.findIndex((command) => command.includes("close-surface"));
  const focusCommands = commands.filter((command) => command.includes("focus-panel"));
  expect(navigateIndex).toBeGreaterThan(renameIndex);
  expect(closeIndex).toBeGreaterThan(navigateIndex);
  expect(focusCommands).toHaveLength(0);
});

test("closes a newly created Dock surface when navigation fails", async () => {
  const commands: string[][] = [];
  const host = await detected(async (command) => {
    commands.push(command);
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    if (command.includes("new-surface")) return ok({ dock_surface_id: ids.dockSurface });
    if (command.includes("navigate")) return { exitCode: 1, stdout: "", stderr: "navigation failed" };
    return ok({ surface_id: ids.dockSurface });
  });
  await expect(host.openView({ url: "http://127.0.0.1:8420/recents/launch?ticket=navigation-failure", kind: "recents", focus: false, target: host.launchTarget() })).rejects.toMatchObject({ code: "command_failed" });
  const navigateIndex = commands.findIndex((command) => command.includes("navigate"));
  const closeIndex = commands.findIndex((command) => command.includes("close-surface"));
  expect(commands.some((command) => command.includes("rename-tab") && command.includes(ids.dockSurface))).toBe(false);
  expect(closeIndex).toBeGreaterThan(navigateIndex);
});

test("reports Dock-disabled and non-loopback placement as structured errors", async () => {
  const host = await detected(async (command) => {
    if (command.includes("--version")) return { exitCode: 0, stdout: versionOutput, stderr: "" };
    if (command.includes("identify")) return ok(identity);
    if (command.includes("tree")) return ok(tree());
    return { exitCode: 1, stdout: "", stderr: "Error: invalid_params: Dock placement is disabled" };
  });
  const target = host.launchTarget();
  await expect(host.openView({ url: "http://127.0.0.1:8420/recents", kind: "recents", focus: true, target })).rejects.toMatchObject({ code: "dock_unavailable" });
  await expect(host.openView({ url: "https://example.com", kind: "document", focus: true, target })).rejects.toBeInstanceOf(CmuxHostError);
});
