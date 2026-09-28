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
const lookup: PaseoLookup = {
  terminalWorkspace: async id => id === "t1" ? "ws-t" : null,
  workspaces: async () => [
    { id: "ws-a", directory: "/w/a", projectRoot: "/w" },
    { id: "ws-a-sub", directory: "/w/a/sub", projectRoot: "/w" },
    { id: "ws-b", directory: "/w/b", projectRoot: "/w" },
  ],
};

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
    expect(first.intents).toEqual([{ id: "i1", url: "http://127.0.0.1:1/launch?ticket=i1", workspaceId: "ws-a" }]);
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

  test("new Folio entries light the most specific workspace; the user's own opens and old entries do not", async () => {
    let now = 50_000;
    const tether = fakeTether([entry("/w/a/old.md", 100)]);
    const hub = new Hub({ run: tether.run, now: () => now, pumpMs: 20 });
    hub.attach(lookup);
    hub.start();
    tether.push({ cursor: 0, folio: 1, intents: [], instanceId: "d1" });
    await settle();
    expect((await hub.pump(0, false)).notices).toEqual({});

    await hub.open("/w/b/mine.md", "ws-b");
    expect(tether.envs.at(-1)).toEqual({ TETHER_PASEO_WORKSPACE_ID: "ws-b", TETHER_PASEO_ORIGIN: "user" });
    tether.state.files = [entry("/w/a/sub/new.md", 50_500), entry("/w/b/mine.md", 50_400), entry("/w/a/old.md", 100)];
    tether.push({ cursor: 0, folio: 2, intents: [], instanceId: "d1" });
    await settle();
    const batch = await hub.pump(0, false);
    expect(batch.notices).toEqual({ "ws-a-sub": { path: "/w/a/sub/new.md", name: "new.md" } }); // Folio title, not the file stem
    expect(batch.folio?.map(file => file.path)).toEqual(["/w/a/sub/new.md", "/w/b/mine.md", "/w/a/old.md"]);

    // Opening the announced document clears its notice.
    await hub.open("/w/a/sub/new.md", "ws-a-sub");
    expect((await hub.pump(0, false)).notices).toEqual({});
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
      await expect(run(["garbage"])).rejects.toMatchObject({ code: "tether_output_invalid", message: expect.stringContaining("boom") });
    } finally {
      delete process.env.PASEO_TERMINAL_ID;
      await rm(root, { recursive: true, force: true });
    }
  });
});
