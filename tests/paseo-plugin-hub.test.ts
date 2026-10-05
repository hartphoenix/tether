import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hub, type PaseoLookup } from "../integrations/paseo/server/hub";
import { createTetherRunner, TetherError } from "../integrations/paseo/server/tether-cli";

type Batch = { cursor: number; folio: number; intents: unknown[]; instanceId: string };

/** A scripted Tether: `paseo wait` yields queued batches in order and otherwise blocks. */
function fakeTether(files: Array<Record<string, unknown>> = []) {
  const batches: Batch[] = [];
  let release: (() => void) | undefined;
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const state = { files };
  const run = async (args: string[], env?: Record<string, string>) => {
    calls.push(args);
    envs.push(env);
    if (args[0] === "paseo" && args[1] === "wait") {
      while (!batches.length) await new Promise<void>(resolve => { release = resolve; });
      return batches.shift();
    }
    if (args[0] === "folio" && args[1] === "list") return { files: state.files };
    return {};
  };
  const push = (batch: Batch) => { batches.push(batch); release?.(); };
  return { run, push, calls, envs, state };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const entry = (path: string, openedAt: number) => ({ path, name: path.split("/").pop(), directory: "/w", repository: null, pinned: false, missing: false, attentionCount: 0, openedAt });
const intent = (id: string, seq: number, extra: Record<string, unknown> = {}) => ({ id, seq, url: `http://127.0.0.1:1/launch?ticket=${id}`, path: "/w/a/doc.md", kind: "document", origin: "user", target: { host: "paseo", workspaceId: "ws-a" }, expiresAt: Date.now() + 30_000, ...extra });
const lookup: PaseoLookup = { terminalWorkspace: async id => id === "t1" ? "ws-t" : null };

describe("plugin hub", () => {
  test("hands a user intent to one executor at a time and re-offers it after its lease", async () => {
    let now = 1_000;
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, now: () => now, leaseMs: 10_000, pumpMs: 50 });
    hub.start();
    tether.push({ cursor: 1, folio: 0, intents: [intent("i1", 1)], instanceId: "d1" });
    await settle();
    const viewer = await hub.pump(0, false);
    expect(viewer.intents).toEqual([]);
    const first = await hub.pump(0, true);
    expect(first.intents).toEqual([{ id: "i1", url: "http://127.0.0.1:1/launch?ticket=i1", workspaceId: "ws-a", path: "/w/a/doc.md" }]);
    expect((await hub.pump(first.revision, true)).intents).toEqual([]);
    now += 10_001;
    expect((await hub.pump(first.revision, true)).intents.map(item => item.id)).toEqual(["i1"]);
    expect(await hub.ack(["i1"])).toBe(1);
    expect(tether.calls).toContainEqual(["paseo", "ack", "i1"]);
    now += 10_001;
    expect((await hub.pump(first.revision, true)).intents).toEqual([]);
    hub.stop();
  });

  test("an agent's open becomes a notice for its workspace, never a tab", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 1, folio: 0, intents: [intent("a1", 1, { origin: "agent", target: { host: "paseo", workspaceId: "ws-b" } })], instanceId: "d1" });
    await settle();
    const batch = await hub.pump(0, true);
    expect(batch.intents).toEqual([]);
    expect(batch.notices).toEqual({ "ws-b": { path: "/w/a/doc.md", name: "doc" } });
    expect(tether.calls).toContainEqual(["paseo", "ack", "a1"]);
    hub.stop();
  });

  test("terminal targets resolve through Paseo", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20 });
    hub.attach(lookup);
    hub.start();
    tether.push({ cursor: 1, folio: 0, intents: [intent("t", 1, { target: { host: "paseo", terminalId: "t1" } })], instanceId: "d1" });
    await settle();
    expect((await hub.pump(0, true)).intents[0]?.workspaceId).toBe("ws-t");
    hub.stop();
  });

  test("a notice lasts until its document is opened anywhere", async () => {
    let now = 50_000;
    const tether = fakeTether([entry("/w/a/doc.md", 49_000)]);
    const hub = new Hub({ run: tether.run, now: () => now, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 1, folio: 1, intents: [intent("a1", 1, { origin: "agent", url: undefined, target: { host: "paseo", workspaceId: "ws-a" } })], instanceId: "d1" });
    await settle();
    expect((await hub.pump(0, false)).notices).toEqual({ "ws-a": { path: "/w/a/doc.md", name: "doc.md" } }); // Folio title

    // A later Folio refresh that predates the notice keeps it.
    tether.push({ cursor: 1, folio: 2, intents: [], instanceId: "d1" });
    await settle();
    expect(Object.keys((await hub.pump(0, false)).notices)).toEqual(["ws-a"]);

    // Opening the document anywhere, e.g. from a reader link, records a newer open and clears it.
    tether.state.files = [entry("/w/a/doc.md", 50_500)];
    tether.push({ cursor: 1, folio: 3, intents: [], instanceId: "d1" });
    await settle();
    expect((await hub.pump(0, false)).notices).toEqual({});
    hub.stop();
  });

  test("opening an announced document clears its notice only after the tab acknowledgement", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 1, folio: 0, intents: [intent("a1", 1, { origin: "agent", url: undefined })], instanceId: "d1" });
    await settle();
    expect(Object.keys((await hub.pump(0, false)).notices)).toEqual(["ws-a"]);
    await hub.open("/w/a/doc.md", "ws-a");
    expect(tether.envs.at(-1)).toEqual({ TETHER_PASEO_WORKSPACE_ID: "ws-a", TETHER_PASEO_ORIGIN: "user" });
    expect(Object.keys((await hub.pump(0, false)).notices)).toEqual(["ws-a"]);
    tether.push({ cursor: 2, folio: 0, intents: [intent("u1", 2)], instanceId: "d1" });
    await settle();
    await hub.ack(["u1"]);
    expect((await hub.pump(0, false)).notices).toEqual({});
    hub.stop();
  });

  test("a Folio launch acknowledgement clears matching notices without a Folio refresh", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 3, folio: 0, intents: [
      intent("a1", 1, { origin: "agent" }),
      intent("a2", 2, { origin: "agent", target: { workspaceId: "ws-b" } }),
      intent("a3", 3, { origin: "agent", path: "/other.md", target: { workspaceId: "ws-c" } }),
    ], instanceId: "d1" });
    await settle();
    tether.push({ cursor: 4, folio: 0, intents: [intent("u1", 4)], instanceId: "d1" });
    await settle();
    const offered = await hub.pump(-1, true);
    expect(Object.keys(offered.notices)).toHaveLength(3);
    const updates = hub.pump(offered.revision, false);
    const reads = tether.calls.filter(call => call[0] === "folio").length;
    await hub.ack(["u1"]);
    expect((await updates).notices).toEqual({ "ws-c": { path: "/other.md", name: "other" } });
    expect(tether.calls.filter(call => call[0] === "folio")).toHaveLength(reads);
    expect(await hub.ack(["u1"])).toBe(0);
    hub.stop();
  });

  test("a delayed launch acknowledgement preserves a newer announcement of the same document", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 2, folio: 0, intents: [intent("a1", 1, { origin: "agent" }), intent("u1", 2)], instanceId: "d1" });
    await settle();
    tether.push({ cursor: 3, folio: 0, intents: [intent("a2", 3, { origin: "agent" })], instanceId: "d1" });
    await settle();
    await hub.ack(["u1"]);
    expect((await hub.pump(-1, false)).notices["ws-a"]?.path).toBe("/w/a/doc.md");
    hub.stop();
  });

  test("notices are withheld when buttons are off", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20, buttons: () => false });
    hub.start();
    tether.push({ cursor: 1, folio: 0, intents: [intent("a1", 1, { origin: "agent" })], instanceId: "d1" });
    await settle();
    expect((await hub.pump(0, false)).notices).toEqual({});
    hub.stop();
  });

  test("the reader-panel setting is read on every pump", async () => {
    let panels = false;
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 20, readerPanels: () => panels });
    expect((await hub.pump(0, false)).readerPanels).toBe(false);
    panels = true;
    expect((await hub.pump(0, false)).readerPanels).toBe(true);
    hub.stop();
  });

  test("a pump resolves at its deadline and wakes early on change", async () => {
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, pumpMs: 60 });
    hub.start();
    const started = Date.now();
    const idle = await hub.pump(0, false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    const early = hub.pump(idle.revision, true);
    tether.push({ cursor: 1, folio: 0, intents: [intent("i2", 1)], instanceId: "d1" });
    expect((await early).intents.map(item => item.id)).toEqual(["i2"]);
    hub.stop();
  });

  test("expired intents are dropped and a restarted daemon resets the cursor", async () => {
    let now = 1_000;
    const tether = fakeTether();
    const hub = new Hub({ run: tether.run, now: () => now, pumpMs: 20 });
    hub.start();
    tether.push({ cursor: 5, folio: 0, intents: [intent("old", 5, { expiresAt: 2_000 })], instanceId: "d1" });
    await settle();
    now = 2_001;
    expect((await hub.pump(0, true)).intents).toEqual([]);
    tether.push({ cursor: 1, folio: 0, intents: [], instanceId: "d2" });
    await settle();
    await settle();
    const lastWait = tether.calls.filter(call => call[1] === "wait").at(-1)!;
    expect(lastWait.slice(2, 4)).toEqual(["--after", "1"]);
    hub.stop();
  });

  test("an outdated Tether is named plainly", async () => {
    const hub = new Hub({ pumpMs: 20, sleep: () => new Promise(resolve => setTimeout(resolve, 1)), run: async () => { throw new TetherError("usage", "Unknown command."); } });
    hub.start();
    await settle();
    expect((await hub.pump(0, false)).status.error).toContain("doesn't support Paseo");
    hub.stop();
  });

  test("a failing Tether is reported in status and retried", async () => {
    let attempts = 0;
    const hub = new Hub({
      pumpMs: 20,
      sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
      run: async () => { attempts += 1; throw new TetherError("tether_not_found", "Tether was not found."); },
    });
    hub.start();
    await settle();
    const batch = await hub.pump(0, false);
    expect(batch.status).toEqual({ connected: false, tether: null, error: "Tether was not found." });
    expect(attempts).toBeGreaterThan(1);
    hub.stop();
  });
});

describe("tether runner", () => {
  test("returns envelope data, raises coded errors, and strips inherited launch context", async () => {
    const root = await mkdtemp("/tmp/tether-paseo-runner-");
    try {
      const binary = join(root, "tether");
      await writeFile(binary, `#!/bin/sh
if [ "$1" = fail ]; then echo '{"protocol":1,"ok":false,"error":{"code":"host_not_connected","message":"No paseo consumer"}}'; exit 1; fi
if [ "$1" = garbage ]; then echo nope; echo boom >&2; exit 3; fi
printf '{"protocol":1,"ok":true,"data":{"profile":"%s","workspace":"%s","terminal":"%s"}}' "$TETHER_PROFILE" "$TETHER_PASEO_WORKSPACE_ID" "$PASEO_TERMINAL_ID"
`);
      await chmod(binary, 0o755);
      process.env.PASEO_TERMINAL_ID = "leaked";
      const run = createTetherRunner({ binary: () => binary, profile: () => "paseo-dev" });
      expect(await run(["status"])).toEqual({ profile: "paseo-dev", workspace: "", terminal: "" });
      expect(await run(["open"], { TETHER_PASEO_WORKSPACE_ID: "w1" })).toEqual({ profile: "paseo-dev", workspace: "w1", terminal: "" });
      await expect(run(["fail"])).rejects.toMatchObject({ code: "host_not_connected" });
      await expect(run(["garbage"])).rejects.toMatchObject({ code: "tether_output_invalid", message: expect.not.stringContaining("boom") });
    } finally {
      delete process.env.PASEO_TERMINAL_ID;
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("Folio launch uses explicit workspace/user context and validates its result", async () => {
  const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  const launch = { url: "http://127.0.0.1:1234/recents/launch?ticket=test", expiresAt: Date.now() + 30_000 };
  const hub = new Hub({ run: async (args, env) => { calls.push({ args, env }); return launch; } });
  expect(await hub.folioView("workspace-a")).toEqual(launch);
  expect(calls).toEqual([{ args: ["folio", "--url", "--host", "paseo"], env: { TETHER_PASEO_WORKSPACE_ID: "workspace-a", TETHER_PASEO_ORIGIN: "user" } }]);
  const invalid = new Hub({ run: async () => ({ url: "invalid" }) });
  await expect(invalid.folioView("workspace-a")).rejects.toThrow();
  const unavailable = new Hub({ run: async () => { throw new Error("Tether unavailable"); } });
  await expect(unavailable.folioView("workspace-a")).rejects.toThrow("Tether unavailable");
});

test("daemon identity changes clear held launches and notices even with equal Folio versions", async () => {
  const tether = fakeTether([entry("/old.md", 1)]);
  const hub = new Hub({ run: tether.run });
  tether.push({ cursor: 2, folio: 1, intents: [intent("old-user", 1), intent("old-agent", 2, { origin: "agent" })], instanceId: "old" });
  await hub.pullOnce();
  expect((await hub.pump(-1, true)).intents).toHaveLength(1);
  tether.state.files = [entry("/new.md", 1)];
  tether.push({ cursor: 0, folio: 1, intents: [], instanceId: "new" });
  await hub.pullOnce();
  expect(await hub.pump(-1, true)).toMatchObject({ folio: [{ path: "/new.md" }], notices: {}, intents: [], status: { tether: "new" } });
  hub.stop();
});

test("failed Folio refresh is retried at the same version", async () => {
  const tether = fakeTether([entry("/new.md", 1)]);
  let fails = true;
  const hub = new Hub({ run: (args, env) => {
    if (args[0] === "folio" && fails) { fails = false; throw new Error("temporary failure"); }
    return tether.run(args, env);
  } });
  tether.push({ cursor: 0, folio: 1, intents: [], instanceId: "daemon" });
  await expect(hub.pullOnce()).rejects.toThrow("temporary failure");
  tether.push({ cursor: 0, folio: 1, intents: [], instanceId: "daemon" });
  await hub.pullOnce();
  expect((await hub.pump(-1, false)).folio?.[0]?.path).toBe("/new.md");
  hub.stop();
});

test("failed acknowledgement retains the intent for deduplicated redelivery", async () => {
  const tether = fakeTether();
  let fails = true;
  const hub = new Hub({ run: (args, env) => {
    if (args[1] === "ack" && fails) { fails = false; throw new Error("temporary failure"); }
    return tether.run(args, env);
  } });
  tether.push({ cursor: 1, folio: 1, intents: [intent("retry", 1)], instanceId: "daemon" });
  await hub.pullOnce();
  await expect(hub.ack(["retry"])).rejects.toThrow("temporary failure");
  expect((await hub.pump(-1, true)).intents.map(item => item.id)).toEqual(["retry"]);
  expect(await hub.ack(["retry"])).toBe(1);
  expect((await hub.pump(-1, true)).intents).toEqual([]);
  hub.stop();
});

test("stop during workspace lookup prevents late intents and follow-up CLI calls", async () => {
  const tether = fakeTether();
  let release!: (value: string) => void;
  const hub = new Hub({ run: tether.run });
  hub.attach({ terminalWorkspace: () => new Promise(resolve => { release = resolve; }) });
  tether.push({ cursor: 1, folio: 1, intents: [intent("late", 1, { target: { terminalId: "t" } })], instanceId: "daemon" });
  const pending = hub.pullOnce();
  await settle();
  hub.stop();
  release("ws");
  await expect(pending).rejects.toThrow("connection changed");
  expect(tether.calls).toHaveLength(1);
  expect((await hub.pump(-1, true)).intents).toEqual([]);
});
