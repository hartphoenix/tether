import { expect, test } from "bun:test";
import { SUPPORTED_WAVE_VERSION, WaveHostAdapter, type WaveCommandResult } from "../src/hosts/wave";

test("detects Wave 0.14.5 and creates a hidden-navigation web block", async () => {
  const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const run = async (command: string[], env: NodeJS.ProcessEnv): Promise<WaveCommandResult> => {
    calls.push({ command, env });
    return { exitCode: 0, stdout: command[1] === "version" ? `wsh v${SUPPORTED_WAVE_VERSION}` : "", stderr: "" };
  };
  const adapter = new WaveHostAdapter({
    wshPath: "wsh",
    env: {
      WAVETERM: "1",
      TERM_PROGRAM: "waveterm",
      WAVETERM_JWT: "in-memory-only",
      WAVETERM_WORKSPACEID: "workspace-one",
      WAVETERM_TABID: "tab-one",
      UNRELATED_SECRET: "must-not-pass",
    },
    run,
  });

  expect(await adapter.detect()).toBe(true);
  expect(adapter.capabilities()).toEqual({
    embeddedBrowser: true,
    hiddenNavigation: true,
    widgetInstallation: true,
    fileNavigatorHook: false,
    revealFile: true,
  });
  expect(adapter.launchTarget()).toEqual({ host: "wave", version: SUPPORTED_WAVE_VERSION, workspaceId: "workspace-one", tabId: "tab-one" });
  expect(await adapter.openView({ url: "http://127.0.0.1:8420/launch?ticket=one", kind: "document", focus: true, target: { workspaceId: "workspace-two", tabId: "tab-two" } })).toEqual({ launchConsumed: true });
  expect(calls.at(-1)?.command).toEqual([
    "wsh", "createblock", "web", "url=http://127.0.0.1:8420/launch?ticket=one", "web:hidenav=true",
  ]);
  expect(calls.at(-1)?.env).toMatchObject({ WAVETERM_JWT: "in-memory-only", WAVETERM_WORKSPACEID: "workspace-two", WAVETERM_TABID: "tab-two" });
  expect(calls.at(-1)?.env.UNRELATED_SECRET).toBeUndefined();
});

test("uses the documented web-open fallback outside the verified Wave version", async () => {
  const commands: string[][] = [];
  const adapter = new WaveHostAdapter({
    wshPath: "wsh",
    env: { WAVETERM: "1", WAVETERM_JWT: "jwt" },
    run: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: command[1] === "version" ? "wsh v0.15.0" : "", stderr: "" };
    },
  });
  expect(await adapter.detect()).toBe(true);
  expect(adapter.capabilities().hiddenNavigation).toBe(false);
  await adapter.openView({ url: "http://127.0.0.1:8420/", kind: "document", focus: true });
  expect(commands.at(-1)).toEqual(["wsh", "web", "open", "http://127.0.0.1:8420/"]);
});

test("resolves a cmd widget's containing tab from its JWT-bound block", async () => {
  const payload = Buffer.from(JSON.stringify({ blockid: "launcher-block" })).toString("base64url");
  const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const adapter = new WaveHostAdapter({
    wshPath: "wsh",
    env: { WAVETERM: "1", WAVETERM_JWT: `header.${payload}.signature` },
    run: async (command, env) => {
      calls.push({ command, env });
      if (command[1] === "version") return { exitCode: 0, stdout: "wsh v0.14.5", stderr: "" };
      if (command[1] === "blocks") return { exitCode: 0, stdout: JSON.stringify([{ blockid: "launcher-block", tabid: "resolved-tab", workspaceid: "resolved-workspace" }]), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  expect(await adapter.detect()).toBe(true);
  expect(adapter.launchTarget()).toMatchObject({ blockId: "launcher-block" });
  await adapter.openView({ url: "http://127.0.0.1:8420/", kind: "document", focus: true });
  expect(calls.at(-2)?.command).toEqual(["wsh", "blocks", "list", "--json"]);
  expect(calls.at(-1)?.env).toMatchObject({ WAVETERM_TABID: "resolved-tab", WAVETERM_WORKSPACEID: "resolved-workspace" });
});

test("does not claim Wave outside Wave or place a view without its injected JWT", async () => {
  const outside = new WaveHostAdapter({ env: {}, wshPath: "wsh", run: async () => ({ exitCode: 0, stdout: "wsh v0.14.5", stderr: "" }) });
  expect(await outside.detect()).toBe(false);
  const missingCredential = new WaveHostAdapter({
    env: { WAVETERM: "1" },
    wshPath: "wsh",
    run: async () => ({ exitCode: 0, stdout: "wsh v0.14.5", stderr: "" }),
  });
  expect(await missingCredential.detect()).toBe(true);
  expect(missingCredential.openView({ url: "http://127.0.0.1:8420/", kind: "document", focus: true })).rejects.toThrow("WAVETERM_JWT");
});

test("a Wave widget removes its launcher block immediately after placing the web view", async () => {
  const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const adapter = new WaveHostAdapter({
    wshPath: "wsh",
    env: { WAVETERM: "1", WAVETERM_JWT: "jwt", WAVETERM_BLOCKID: "launcher", WAVETERM_TABID: "tab", TETHER_WAVE_LAUNCHER: "1" },
    run: async (command, env) => {
      calls.push({ command, env });
      return { exitCode: 0, stdout: command[1] === "version" ? "wsh v0.14.5" : "", stderr: "" };
    },
  });
  expect(await adapter.detect()).toBe(true);
  await adapter.openView({ url: "http://127.0.0.1:8420/", kind: "document", focus: true, target: adapter.launchTarget() });
  expect(calls.slice(-2).map(({ command }) => command)).toEqual([
    ["wsh", "createblock", "web", "url=http://127.0.0.1:8420/", "web:hidenav=true"],
    ["wsh", "deleteblock", "-b", "launcher"],
  ]);
  expect(calls.at(-1)?.env.WAVETERM_BLOCKID).toBe("launcher");
});

test("synchronizes recent entries through the Wave launcher adapter", async () => {
  const synchronized: string[][] = [];
  const adapter = new WaveHostAdapter({
    syncRecents: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
  });
  await adapter.recentsChanged([{ path: "/docs/review.md", createdAt: 1 }]);
  expect(synchronized).toEqual([["/docs/review.md"]]);
});
