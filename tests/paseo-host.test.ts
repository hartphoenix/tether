import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { resolveConfig, type TetherConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { PullQueue } from "../src/hosts/pull-queue";
import { PaseoHostAdapter, paseoLaunchTarget } from "../src/hosts/paseo";
import type { PullBatch, PullIntent } from "../src/hosts/pull-queue";

describe("pull queue", () => {
  test("refuses intents until a consumer has waited", async () => {
    const queue = new PullQueue({ ttlMs: 30_000 });
    expect(() => queue.enqueue("paseo", { url: "u", kind: "document", origin: "user" })).toThrow(/No paseo consumer/);
    await queue.wait("paseo", 0, -1, 0);
    expect(queue.enqueue("paseo", { url: "u", kind: "document", origin: "user" }).seq).toBe(1);
  });

  test("a waiting consumer wakes on a new intent and re-receives it until acked", async () => {
    const queue = new PullQueue({ ttlMs: 30_000 });
    const folio = queue.status("paseo").folio;
    const pending = queue.wait("paseo", 0, folio, 5_000);
    const intent = queue.enqueue("paseo", { url: "u", path: "/doc.md", kind: "document", origin: "user" });
    expect((await pending).intents.map(item => item.id)).toEqual([intent.id]);
    expect((await queue.wait("paseo", 0, folio, 0)).intents).toHaveLength(1);
    expect((await queue.wait("paseo", intent.seq, folio, 0)).intents).toHaveLength(0);
    expect(queue.ack("paseo", [intent.id])).toBe(1);
    expect((await queue.wait("paseo", 0, folio, 0)).intents).toHaveLength(0);
  });

  test("Folio changes wake waiters; expiry drops intents; close releases waits", async () => {
    let now = 1_000;
    const queue = new PullQueue({ ttlMs: 30_000, now: () => now });
    const first = queue.wait("paseo", 0, 0, 5_000);
    queue.folioChanged();
    expect((await first).folio).toBe(1);
    queue.enqueue("paseo", { url: "u", kind: "document", origin: "user" });
    now += 30_001;
    expect(queue.status("paseo").pending).toBe(0);
    const held = queue.wait("paseo", 0, 1, 60_000);
    queue.close();
    expect((await held).intents).toEqual([]);
  });

  test("presence lapses after the presence window", async () => {
    let now = 0;
    const queue = new PullQueue({ ttlMs: 30_000, presenceMs: 30_000, now: () => now });
    await queue.wait("paseo", 0, -1, 0);
    expect(queue.present("paseo")).toBe(true);
    now += 30_000;
    expect(queue.present("paseo")).toBe(false);
  });
});

describe("paseo adapter", () => {
  test("launch target prefers the plugin's workspace over a terminal id", () => {
    expect(paseoLaunchTarget({ TETHER_PASEO_WORKSPACE_ID: "w1", PASEO_TERMINAL_ID: "t1" })).toEqual({ host: "paseo", workspaceId: "w1" });
    expect(paseoLaunchTarget({ PASEO_TERMINAL_ID: "t1" })).toEqual({ host: "paseo", terminalId: "t1" });
    expect(paseoLaunchTarget({ PASEO_AGENT_ID: "a1" })).toBeUndefined();
  });

  test("agent opens only notify and release their ticket; user opens consume it", async () => {
    const sent: unknown[] = [];
    const enqueue = async (intent: unknown) => { sent.push(intent); };
    const agent = new PaseoHostAdapter({ enqueue, env: { TETHER_PASEO_WORKSPACE_ID: "w1" } });
    expect(await agent.openView({ url: "u", path: "/d.md", kind: "document", focus: true })).toEqual({ launchConsumed: false, notified: true });
    const user = new PaseoHostAdapter({ enqueue, env: { TETHER_PASEO_WORKSPACE_ID: "w1", TETHER_PASEO_ORIGIN: "user" } });
    expect(await user.openView({ url: "u", path: "/d.md", kind: "document", focus: true })).toEqual({ launchConsumed: true });
    expect(sent).toEqual([
      { url: "u", kind: "document", origin: "agent", path: "/d.md", target: { host: "paseo", workspaceId: "w1" } },
      { url: "u", kind: "document", origin: "user", path: "/d.md", target: { host: "paseo", workspaceId: "w1" } },
    ]);
  });
});

describe("paseo host through the daemon", () => {
  let root: string;
  let config: TetherConfig;
  let daemon: TetherDaemon;
  let document: string;
  const environmentKeys = ["TETHER_PASEO_WORKSPACE_ID", "TETHER_PASEO_ORIGIN", "PASEO_TERMINAL_ID"] as const;
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));

  beforeAll(async () => {
    root = await realpath(await mkdtemp("/tmp/tether-paseo-host-"));
    config = resolveConfig({ runtimeDir: join(root, "runtime"), configDir: join(root, "config") });
    daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("test") });
    await daemon.ready;
    document = join(root, "doc.md");
    await writeFile(document, "# Paseo fixture\n\n[[other]]\n");
    await writeFile(join(root, "other.md"), "# Other\n");
  });

  beforeEach(() => {
    // The launching terminal must not supply a workspace or announce fixture mutations.
    for (const key of environmentKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  afterAll(async () => {
    await daemon?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const wait = async (after = 0, folio = -1, timeout = 0) => {
    const result = await runCli(["paseo", "wait", "--after", String(after), "--folio", String(folio), "--timeout", String(timeout)], { config });
    if (!result.response.ok) throw new Error(JSON.stringify(result.response));
    return result.response.data as PullBatch & { instanceId: string };
  };
  const drain = async () => {
    const batch = await wait();
    if (batch.intents.length) await runCli(["paseo", "ack", ...batch.intents.map(intent => intent.id)], { config });
    return batch;
  };

  test("an explicit paseo open fails clearly without a consumer", async () => {
    // A fresh daemon has no consumer yet.
    const fresh = createDaemon({ config: resolveConfig({ runtimeDir: join(root, "runtime-2"), configDir: join(root, "config-2") }), startupGraceMs: 600_000, web: () => new Response("test") });
    await fresh.ready;
    try {
      process.env.TETHER_PASEO_WORKSPACE_ID = "w1";
      const result = await runCli(["open", document, "--host", "paseo"], { config: resolveConfig({ runtimeDir: join(root, "runtime-2"), configDir: join(root, "config-2") }) });
      expect(result).toMatchObject({ exitCode: 1, response: { ok: false, error: { code: "host_not_connected" } } });
    } finally { await fresh.stop(); }
  });

  test("a user open queues a document intent with its path and workspace", async () => {
    await wait();
    process.env.TETHER_PASEO_WORKSPACE_ID = "w1";
    process.env.TETHER_PASEO_ORIGIN = "user";
    const opened = await runCli(["open", document, "--host", "paseo"], { config });
    expect(opened.response).toMatchObject({ ok: true, data: { opened: true } });
    const batch = await drain();
    expect(batch.intents).toHaveLength(1);
    const intent = batch.intents[0] as PullIntent;
    expect(intent).toMatchObject({ kind: "document", origin: "user", path: document, target: { host: "paseo", workspaceId: "w1" } });
    expect((await fetch(intent.url!, { redirect: "manual" })).status).toBe(302);
  });

  test("an agent open notifies without opening and releases its ticket", async () => {
    await wait();
    process.env.TETHER_PASEO_WORKSPACE_ID = "w2";
    const opened = await runCli(["open", document], { config });
    expect(opened.response).toMatchObject({ ok: true, data: { opened: false, notified: true } });
    const intent = (await drain()).intents[0] as PullIntent;
    expect(intent).toMatchObject({ origin: "agent", path: document, target: { host: "paseo", workspaceId: "w2" } });
    expect((await fetch(intent.url!, { redirect: "manual" })).status).toBe(401);
  });

  test("auto selection picks a connected Paseo from a Paseo terminal", async () => {
    await wait();
    process.env.PASEO_TERMINAL_ID = "t1";
    const opened = await runCli(["open", document], { config });
    expect(opened.response).toMatchObject({ ok: true, data: { notified: true } });
    expect((await drain()).intents[0]).toMatchObject({ origin: "agent", target: { host: "paseo", terminalId: "t1" } });
  });

  test("a link clicked in a Paseo reader opens beside it as a user intent", async () => {
    await wait();
    process.env.TETHER_PASEO_WORKSPACE_ID = "w3";
    process.env.TETHER_PASEO_ORIGIN = "user";
    await runCli(["open", document, "--host", "paseo"], { config });
    const launch = (await drain()).intents[0] as PullIntent;
    const exchange = await fetch(launch.url!, { redirect: "manual" });
    const location = exchange.headers.get("location")!;
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    await wait();
    const clicked = await fetch(new URL("api/open", `${daemon.origin}${location}`), {
      method: "POST",
      headers: { cookie, origin: daemon.origin, "content-type": "application/json" },
      body: JSON.stringify({ target: "other" }),
    });
    expect(clicked.status).toBe(200);
    const linked = (await drain()).intents[0] as PullIntent;
    expect(linked).toMatchObject({ origin: "user", path: join(root, "other.md"), target: { host: "paseo", workspaceId: "w3" } });
  });

  test("a Paseo reader opens linked documents itself, through its own session", async () => {
    await wait();
    process.env.TETHER_PASEO_WORKSPACE_ID = "w4";
    process.env.TETHER_PASEO_ORIGIN = "user";
    await runCli(["open", document, "--host", "paseo"], { config });
    const launch = (await drain()).intents[0] as PullIntent;
    const exchange = await fetch(launch.url!, { redirect: "manual" });
    const reader = new URL(exchange.headers.get("location")!, daemon.origin);
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    const bootstrap = await (await fetch(new URL("api/bootstrap", reader), { headers: { cookie } })).json() as { capabilities: { pageOpensLinks?: boolean } };
    expect(bootstrap.capabilities.pageOpensLinks).toBe(true);

    await wait();
    const linked = await fetch(new URL("api/link?target=other&format=wikilink", reader), { headers: { cookie }, redirect: "manual" });
    expect(linked.status).toBe(302);
    const ticketUrl = linked.headers.get("location")!;
    expect(ticketUrl).toContain("/launch?ticket=");
    const opened = await fetch(ticketUrl, { redirect: "manual" });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toMatch(/^\/s\/[^/]+\/$/);
    // The page opened it; nothing was queued for the plugin.
    expect((await wait()).intents).toEqual([]);

    const missing = await fetch(new URL("api/link?target=absent&format=wikilink", reader), { headers: { cookie }, redirect: "manual" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");
    expect(await missing.text()).toContain("couldn't be opened");
    expect((await fetch(new URL("api/link?target=other", reader), { redirect: "manual" })).status).not.toBe(302);
  });

  test("Folio mutations wake a waiting consumer", async () => {
    const initial = await wait();
    const pending = wait(initial.cursor, initial.folio, 10);
    await runCli(["recents", "add", document], { config });
    const woke = await pending;
    expect(woke.folio).toBeGreaterThan(initial.folio);
  });

  test("status reports presence", async () => {
    await wait();
    const status = await runCli(["paseo", "status"], { config });
    expect(status.response).toMatchObject({ ok: true, data: { present: true, pending: 0 } });
  });
});
