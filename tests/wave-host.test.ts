import { expect, test } from "bun:test";
import { SUPPORTED_WAVE_VERSION, WaveHostAdapter, type WaveCommandResult } from "../src/hosts/wave";

test("detects Wave 0.14.5 and creates a hidden-navigation web block", async () => {
  const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const run = async (command: string[], env: NodeJS.ProcessEnv): Promise<WaveCommandResult> => {
    calls.push({ command, env });
    return { exitCode: 0, stdout: command[1] === "version" ? `wsh v${SUPPORTED_WAVE_VERSION}` : "", stderr: "" };
  };
  const adapter = new WaveHostAdapter({
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
  await adapter.openView("http://127.0.0.1:8420/launch?ticket=one", { workspaceId: "workspace-two", tabId: "tab-two" });
  expect(calls.at(-1)?.command).toEqual([
    "wsh", "createblock", "web", "url=http://127.0.0.1:8420/launch?ticket=one", "web:hidenav=true",
  ]);
  expect(calls.at(-1)?.env).toMatchObject({ WAVETERM_JWT: "in-memory-only", WAVETERM_WORKSPACEID: "workspace-two", WAVETERM_TABID: "tab-two" });
  expect(calls.at(-1)?.env.UNRELATED_SECRET).toBeUndefined();
});

test("uses the documented web-open fallback outside the verified Wave version", async () => {
  const commands: string[][] = [];
  const adapter = new WaveHostAdapter({
    env: { WAVETERM: "1", WAVETERM_JWT: "jwt" },
    run: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: command[1] === "version" ? "wsh v0.15.0" : "", stderr: "" };
    },
  });
  expect(await adapter.detect()).toBe(true);
  expect(adapter.capabilities().hiddenNavigation).toBe(false);
  await adapter.openView("http://127.0.0.1:8420/");
  expect(commands.at(-1)).toEqual(["wsh", "web", "open", "http://127.0.0.1:8420/"]);
});

test("does not claim Wave outside Wave or place a view without its injected JWT", async () => {
  const outside = new WaveHostAdapter({ env: {}, run: async () => ({ exitCode: 0, stdout: "wsh v0.14.5", stderr: "" }) });
  expect(await outside.detect()).toBe(false);
  const missingCredential = new WaveHostAdapter({
    env: { WAVETERM: "1" },
    run: async () => ({ exitCode: 0, stdout: "wsh v0.14.5", stderr: "" }),
  });
  expect(await missingCredential.detect()).toBe(true);
  expect(missingCredential.openView("http://127.0.0.1:8420/")).rejects.toThrow("WAVETERM_JWT");
});
