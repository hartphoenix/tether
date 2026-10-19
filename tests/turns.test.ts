import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../src/cli/commands";
import { runCli } from "../src/cli/main";
import { readControlToken, resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { TurnSignals } from "../src/server/turns";
import { createIconBag } from "../src/web/turn-button";
import { turnIcons } from "../src/web/turn-icons";
import { agentColorIndex } from "../src/web/agent-colors";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join("/tmp", "tether-turns-"));
  directories.push(directory);
  const path = join(directory, "document.md");
  await writeFile(path, "Body\n");
  const config = resolveConfig({ profile: "turns", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  return { path: await realpath(path), config, daemon };
}

async function session(daemon: TetherDaemon, path: string) {
  const launch = daemon.mintTicket(await daemon.service.open(path));
  const response = await fetch(launch.url, { redirect: "manual" });
  const location = response.headers.get("location")!;
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  return (pathname: string, init: RequestInit = {}) => fetch(new URL(pathname, `${daemon.origin}${location}`).href, {
    ...init, headers: { cookie, origin: daemon.origin, "content-type": "application/json", ...init.headers },
  });
}

async function controlWait(daemon: TetherDaemon, body: Record<string, unknown>, signal?: AbortSignal) {
  const token = await readControlToken(daemon.config);
  return fetch(`${daemon.origin}/control/turn/wait`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
}

test("each agent on a document receives only its own presses", async () => {
  const turns = new TurnSignals("instance-a");
  const security = turns.wait("/doc.md", "security", "Security sweep", undefined, 5_000);
  const elegance = turns.wait("/doc.md", "elegance", undefined, undefined, 50);
  expect(turns.agents("/doc.md")).toEqual([{ actor: "elegance", state: "ready" }, { actor: "security", label: "Security sweep", state: "ready" }]);
  expect(turns.request("/doc.md", "Security")).toEqual({ cursor: "instance-a:1", sequence: 1, actor: "security" });
  expect(await security).toMatchObject({ turn: { cursor: "instance-a:1", sequence: 1, path: "/doc.md", actor: "security" } });
  expect(await elegance).toEqual({ turn: null, cursor: "instance-a:0" });
  expect(turns.request("/doc.md", "security")).toBe("working");
  expect(turns.request("/doc.md", "nobody")).toBe("unavailable");
  expect(turns.request("/other.md", "elegance")).toBe("unavailable");
  // An older cursor sees the undelivered press at once; a foreign instance's cursor counts as 0.
  expect(await turns.wait("/doc.md", "security", undefined, "instance-a:0", 5_000)).toMatchObject({ turn: { sequence: 1 } });
  expect(await turns.wait("/doc.md", "security", undefined, "instance-b:7", 5_000)).toMatchObject({ turn: { sequence: 1 } });
  expect(turns.agents("/doc.md").find(agent => agent.actor === "security")?.state).toBe("working");
});

test("agents move ready to working to ready across a re-arm, and expire", async () => {
  let now = 1_000_000;
  const turns = new TurnSignals("i", () => now);
  expect(await turns.wait("/d.md", "agent", undefined, undefined, 10)).toEqual({ turn: null, cursor: "i:0" });
  expect(turns.agents("/d.md")).toEqual([{ actor: "agent", state: "ready" }]);
  turns.request("/d.md", "agent");
  expect(turns.agents("/d.md")[0]!.state).toBe("working");
  now += 60 * 60_000;
  expect(turns.agents("/d.md")[0]!.state).toBe("working");
  // Re-arming with the delivered cursor ends the turn.
  const controller = new AbortController();
  const rearmed = turns.wait("/d.md", "agent", undefined, "i:1", 5_000, controller.signal);
  expect(turns.agents("/d.md")[0]!.state).toBe("ready");
  controller.abort();
  expect(await rearmed).toEqual({ turn: null, cursor: "i:1" });
  // Between chained polls the agent stays ready through the grace, then disappears.
  now += 59_000;
  expect(turns.agents("/d.md")).toHaveLength(1);
  expect(turns.waiting()).toBe(true);
  now += 2_000;
  expect(turns.agents("/d.md")).toEqual([]);
  expect(turns.waiting()).toBe(false);
  // A working agent that never re-arms is dropped after two hours.
  await turns.wait("/d.md", "slow", undefined, undefined, 0);
  turns.request("/d.md", "slow");
  now += 2 * 60 * 60_000 + 1;
  expect(turns.agents("/d.md")).toEqual([]);
});

test("an agent dropped while its watcher was away resumes from its cursor", async () => {
  let now = 1_000_000;
  const turns = new TurnSignals("i", () => now);
  await turns.wait("/d.md", "agent", undefined, undefined, 0);
  turns.request("/d.md", "agent");
  turns.request("/d.md", "agent");
  await turns.wait("/d.md", "agent", undefined, "i:1", 0);
  turns.request("/d.md", "agent");
  expect(await turns.wait("/d.md", "agent", undefined, "i:1", 0)).toMatchObject({ turn: { sequence: 2 } });
  // A sleeping laptop outlasts the grace, so the daemon forgets the agent.
  await turns.wait("/d.md", "agent", undefined, "i:2", 0);
  now += 2 * 60 * 60_000 + 1;
  expect(turns.agents("/d.md")).toEqual([]);
  const resumed = turns.wait("/d.md", "agent", undefined, "i:2", 5_000);
  expect(turns.request("/d.md", "agent")).toEqual({ cursor: "i:3", sequence: 3, actor: "agent" });
  expect(await resumed).toMatchObject({ turn: { cursor: "i:3", sequence: 3 } });
});

test("a deliberate stop releases waiters with stopped and refuses new waits", async () => {
  const turns = new TurnSignals("i");
  const open = turns.wait("/d.md", "agent", undefined, undefined, 5_000);
  turns.close(true);
  expect(await open).toEqual({ turn: null, stopped: true });
  expect(await turns.wait("/d.md", "agent", undefined, undefined, 5_000)).toEqual({ turn: null, stopped: true });
});

test("the reader sees agent state and presses wake only the chosen agent", async () => {
  const { path, daemon } = await fixture();
  const api = await session(daemon, path);
  const agents = async () => (await (await api("api/turns")).json() as { agents: Array<{ actor: string; state: string; label?: string }> }).agents;
  expect(await agents()).toEqual([]);
  const security = controlWait(daemon, { path, actor: "security", label: "Security sweep", timeoutMs: 10_000 });
  const elegance = controlWait(daemon, { path, actor: "elegance", timeoutMs: 10_000 });
  for (let i = 0; i < 50 && (await agents()).length < 2; i++) await Bun.sleep(10);
  expect(await agents()).toEqual([{ actor: "elegance", state: "ready" }, { actor: "security", label: "Security sweep", state: "ready" }]);
  expect((await api("api/turn", { method: "POST", headers: { origin: "http://evil.invalid" }, body: JSON.stringify({ actor: "security" }) })).status).toBe(403);
  expect((await api("api/turn", { method: "POST", body: JSON.stringify({ actor: "nobody" }) })).status).toBe(409);
  const pressed = await (await api("api/turn", { method: "POST", body: JSON.stringify({ actor: "security" }) })).json() as { cursor: string; sequence: number; actor: string };
  expect(pressed).toEqual({ cursor: `${daemon.instanceId}:1`, sequence: 1, actor: "security" });
  expect(await (await security).json()).toMatchObject({ turn: { cursor: pressed.cursor, sequence: 1, path, actor: "security" } });
  expect(await agents()).toEqual([{ actor: "elegance", state: "ready" }, { actor: "security", label: "Security sweep", state: "working" }]);
  expect(await (await api("api/turn", { method: "POST", body: JSON.stringify({ actor: "security" }) })).json()).toMatchObject({ error: { code: "agent_working" } });
  expect(await (await controlWait(daemon, { path, actor: "security", after: pressed.cursor, timeoutMs: 20 })).json()).toEqual({ turn: null, cursor: pressed.cursor });
  expect((await agents()).find(agent => agent.actor === "security")?.state).toBe("ready");
  expect((await controlWait(daemon, { path, timeoutMs: 20 })).status).toBe(400);
  expect((await controlWait(daemon, { path, actor: "a", label: "x".repeat(61), timeoutMs: 20 })).status).toBe(400);
  expect((await controlWait(daemon, { path: join(path, "..", "missing.md"), actor: "a", timeoutMs: 20 })).status).toBe(404);
  const pending = elegance;
  await daemon.stop();
  expect(await (await pending).json()).toMatchObject({ turn: null, cursor: `${daemon.instanceId}:0` });
});

test("tether turn wait parses, returns its own press, and exits on a deliberate stop", async () => {
  expect(parseCommand(["turn", "wait", "doc.md", "--actor", "a", "--label", "Sweep", "--after", "x:1", "--timeout", "3"]).spec.name).toBe("turn.wait");
  expect(() => parseCommand(["turn", "wait", "doc.md"])).toThrow("--actor is required");
  expect(() => parseCommand(["turn", "wait", "doc.md", "--actor", "a", "--label", "x".repeat(61)])).toThrow("60 characters");
  const { path, config, daemon } = await fixture();
  expect((await runCli(["turn", "wait", path, "--actor", "a", "--timeout", "0.05"], { config })).response).toMatchObject({ ok: true, command: "turn.wait", data: { turn: null, cursor: `${daemon.instanceId}:0` } });
  const api = await session(daemon, path);
  const waiting = runCli(["turn", "wait", path, "--actor", "a"], { config });
  await Bun.sleep(300);
  await api("api/turn", { method: "POST", body: JSON.stringify({ actor: "a" }) });
  expect((await waiting).response).toMatchObject({ ok: true, command: "turn.wait", data: { turn: { cursor: `${daemon.instanceId}:1`, sequence: 1, path, actor: "a" } } });
  expect((await runCli(["turn", "wait", path, "--actor", "a", "--after", "earlier-daemon:4"], { config })).response).toMatchObject({ data: { turn: { sequence: 1 } } });
  const stopping = runCli(["turn", "wait", path, "--actor", "a", "--after", `${daemon.instanceId}:1`], { config });
  await Bun.sleep(300);
  const token = await readControlToken(config);
  expect((await fetch(`${daemon.origin}/control/stop`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ deliberate: true }) })).status).toBe(200);
  expect((await stopping).response).toMatchObject({ ok: true, data: { turn: null, stopped: true } });
});

test("a takeover or relocation stop releases waits without telling agents to stay stopped", async () => {
  const { path, daemon } = await fixture();
  const waiting = controlWait(daemon, { path, actor: "a", timeoutMs: 10_000 });
  await Bun.sleep(100);
  const token = await readControlToken(daemon.config);
  expect((await fetch(`${daemon.origin}/control/stop`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  const released = await (await waiting).json() as Record<string, unknown>;
  expect(released.stopped).toBeUndefined();
  expect(released).toMatchObject({ turn: null, cursor: `${daemon.instanceId}:0` });
});

test("agent colors are stable palette slots", () => {
  expect(agentColorIndex("security")).toBe(agentColorIndex(" Security "));
  const slots = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "assistant", "codex"].map(agentColorIndex));
  for (const slot of slots) expect(slot >= 1 && slot <= 6).toBe(true);
  expect(slots.size).toBeGreaterThan(2);
});

test("the turn icon bag shows every face per round without immediate repeats", () => {
  expect(turnIcons.length).toBeGreaterThanOrEqual(4);
  for (const icon of turnIcons) expect(icon).toContain('class="tether-icon');
  let seed = 7;
  const next = createIconBag(["a", "b", "c"], () => ((seed = (seed * 9301 + 49297) % 233280) / 233280));
  const shown = Array.from({ length: 30 }, next);
  for (let round = 0; round < 10; round++) expect(new Set(shown.slice(round * 3, round * 3 + 3)).size).toBe(3);
  for (let i = 1; i < shown.length; i++) expect(shown[i]).not.toBe(shown[i - 1]);
});
