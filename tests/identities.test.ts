import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSignature, runCli } from "../src/cli/main";
import { readControlToken, resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { PrivateStore } from "../src/storage/private-store";
import { ACTIVE_AGENT_MS, AGENT_COLOR_COUNT, AGENT_ICON_NAMES } from "../src/shared/agent-identity";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join("/tmp", "tether-identities-"));
  directories.push(directory);
  const path = join(directory, "document.md");
  await writeFile(path, "A unique passage for agents.\n");
  const config = resolveConfig({ profile: "identities", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const launch = daemon.mintTicket(await daemon.service.open(await realpath(path)));
  const response = await fetch(launch.url, { redirect: "manual" });
  const location = response.headers.get("location")!;
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const api = (pathname: string, init: RequestInit = {}) => fetch(new URL(pathname, `${daemon.origin}${location}`).href, {
    ...init, headers: { cookie, origin: daemon.origin, "content-type": "application/json", ...init.headers },
  });
  const cli = async (args: string[], env: Record<string, string> = {}, body = "A note.") => (await runCli(args, { config, env, readBody: async () => body })).response as { ok: boolean; data?: any; error?: { code: string; message: string } };
  return { path: await realpath(path), config, daemon, api, cli };
}

const agentA = { CLAUDE_CODE_SESSION_ID: "session-a" };
const agentB = { CLAUDE_CODE_SESSION_ID: "session-b" };

test("the CLI signs with --agent-id, then Paseo's ID, then Claude Code's, else asks the daemon to issue one", () => {
  const env = { PASEO_AGENT_ID: "p1", CLAUDE_CODE_SESSION_ID: "c1" };
  expect(agentSignature("given", env)).toEqual({ agentId: "given" });
  expect(agentSignature(undefined, env)).toEqual({ agentId: "paseo:p1" });
  expect(agentSignature(undefined, { CLAUDE_CODE_SESSION_ID: "c1" })).toEqual({ agentId: "claude:c1" });
  expect(agentSignature(undefined, { PASEO_AGENT_ID: " ", CLAUDE_CODE_SESSION_ID: "" })).toEqual({ issueAgentId: true });
});

test("icons go least recently used to agents without one; an exhausted pool reuses the oldest with a new color", () => {
  const store = new PrivateStore();
  let now = 1_000_000;
  const claimed = AGENT_ICON_NAMES.map((_, index) => store.identities.claim(`agent-${index}`, `Agent ${index}`, now += 1_000).identity);
  expect(new Set(claimed.map(identity => identity.icon)).size).toBe(AGENT_ICON_NAMES.length);
  expect(claimed.slice(0, AGENT_COLOR_COUNT).map(identity => identity.colorSlot)).toEqual(Array.from({ length: AGENT_COLOR_COUNT }, (_, index) => index + 1));
  // All 28 are active: the next agent takes the least recently used icon, in a color unlike its holder's.
  const extra = store.identities.claim("extra", "Extra", now += 1_000).identity;
  expect(extra.icon).toBe(claimed[0]!.icon);
  expect(extra.colorSlot).not.toBe(claimed[0]!.colorSlot);
  // Keep every agent but #5 active; 24 hours after #5 was last seen, its icon is the only free one.
  now += ACTIVE_AGENT_MS + 1;
  claimed.forEach((identity, index) => { if (index !== 5) store.identities.touch(identity.id, now); });
  store.identities.touch("extra", now);
  const returned = store.identities.claim("late", "Late", now).identity;
  expect(returned.icon).toBe(claimed[5]!.icon);
  // Old identities keep what they were given.
  expect(store.identities.resolve(["agent-5"])[0]).toEqual(claimed[5]!);
});

test("names are unique among active agents, case-insensitively, and free again after 24 hours", () => {
  const store = new PrivateStore();
  const now = 5_000_000;
  store.identities.claim("a", "Go button design", now);
  expect(() => store.identities.claim("b", " go BUTTON design ", now)).toThrow(/easy to tell apart/);
  expect(() => store.identities.claim("b", "human", now)).toThrow(/reserved/);
  expect(store.identities.claim("b", "Go button review", now).identity.name).toBe("Go button review");
  expect(() => store.identities.rename("b", "go button design", now)).toThrow(/easy to tell apart/);
  expect(store.identities.claim("c", "Go button design", now + ACTIVE_AGENT_MS + 1).identity.name).toBe("Go button design");
});

test("the resolver registers unknown IDs and legacy strings, and identityRevision follows renames", async () => {
  const { api } = await fixture();
  const revision = async () => (await (await api("api/turns")).json() as { identityRevision: number }).identityRevision;
  const before = await revision();
  const resolved = await (await api("api/identities?ids=assistant,claude%3Aunknown,human")).json() as { identities: any[]; identityRevision: number };
  expect(resolved.identities).toEqual([
    { id: "assistant", name: "assistant", icon: expect.any(String), colorSlot: expect.any(Number), kind: "agent" },
    { id: "claude:unknown", name: "claude:unknown", icon: expect.any(String), colorSlot: expect.any(Number), kind: "agent" },
    { id: "human", name: "human", icon: null, colorSlot: null, kind: "human" },
  ]);
  expect(resolved.identities[0].icon).not.toBe(resolved.identities[1].icon);
  const registered = await revision();
  expect(registered).toBeGreaterThan(before);
  // A second lookup registers nothing new.
  await api("api/identities?ids=assistant");
  expect(await revision()).toBe(registered);
  // Lazily registered legacy strings don't hold their name.
  expect((await api("api/identities/rename", { method: "POST", body: JSON.stringify({ id: "claude:unknown", name: "assistant" }) })).status).toBe(200);
  expect(await revision()).toBeGreaterThan(registered);
  expect((await api("api/identities/rename", { method: "POST", headers: { origin: "http://evil.invalid" }, body: JSON.stringify({ id: "assistant", name: "x" }) })).status).toBe(403);
  expect((await (await api("api/changes", { method: "POST", body: JSON.stringify({ clientId: "c" }) })).json() as { identityRevision: number }).identityRevision).toBe(await revision());
});

test("agents sign comments with their IDs; pending and acknowledgement key on the ID; a human rename outranks --actor", async () => {
  const { path, api, cli } = await fixture();
  const comment = await cli(["comment", path, "--actor", "Reviewer", "--quote", "unique passage", "--body-file", "-", "--operation-id", "c1"], agentA);
  expect(comment.ok).toBe(true);
  expect(comment.data.agent).toBeUndefined();
  // Another active agent can't take the name.
  const clash = await cli(["pending", path, "--actor", "reviewer"], agentB);
  expect(clash.error).toMatchObject({ code: "agent_name_taken" });
  const pendingB = await cli(["pending", path, "--actor", "Editor"], agentB);
  expect(pendingB.data.events).toEqual([expect.objectContaining({ type: "comment", actor: "claude:session-a" })]);
  // Own events are excluded by ID.
  expect((await cli(["pending", path, "--actor", "Reviewer"], agentA)).data.events).toEqual([]);
  expect((await cli(["acknowledge", path, "--actor", "Editor", "--cursor", pendingB.data.cursor, "--operation-id", "ack-b"], agentB)).ok).toBe(true);
  expect((await cli(["pending", path, "--actor", "Editor"], agentB)).data.events).toEqual([]);
  // Hart renames agent A; A's own --actor no longer changes it, and every message shows the new name.
  const renamed = await (await api("api/identities/rename", { method: "POST", body: JSON.stringify({ id: "claude:session-a", name: "Security sweep" }) })).json() as { identity: { name: string } };
  expect(renamed.identity.name).toBe("Security sweep");
  const reply = await cli(["reply", path, comment.data.mutation.appliedEventId, "--actor", "Reviewer", "--body-file", "-", "--operation-id", "r1"], agentA);
  expect(reply.data.agent).toMatchObject({ id: "claude:session-a", name: "Security sweep" });
  expect((await (await api("api/identities?ids=claude%3Asession-a")).json() as { identities: Array<{ name: string }> }).identities[0]!.name).toBe("Security sweep");
  // The human's own CLI comments stay the human's.
  expect((await cli(["comment", path, "--actor", "human", "--quote", "unique passage", "--body-file", "-", "--operation-id", "h1"], agentA)).ok).toBe(true);
  const events = (await cli(["pending", path, "--actor", "Editor"], agentB)).data.events as Array<{ actor: string }>;
  expect(events.map(event => event.actor)).toEqual(["claude:session-a", "human"]);
});

test("legacy actor strings without an agent ID stay both ID and name", async () => {
  const { path, config, daemon, cli } = await fixture();
  const token = await readControlToken(config);
  const control = (route: string, body: Record<string, unknown>) => fetch(`${daemon.origin}/control/review/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path, ...body }) }).then(response => response.json() as Promise<any>);
  await cli(["comment", path, "--actor", "human", "--quote", "unique passage", "--body-file", "-", "--operation-id", "h1"]);
  const pending = await control("pending", { actor: "assistant" });
  expect(pending.events).toEqual([expect.objectContaining({ actor: "human" })]);
  await control("reply", { actor: "assistant", threadId: pending.events[0].threadId, body: "Legacy reply.", operationId: "legacy" });
  expect((await control("pending", { actor: "assistant" })).events).toHaveLength(1);
  expect(daemon.service.store.identities.resolve(["assistant"])[0]).toMatchObject({ id: "assistant", name: "assistant", kind: "agent" });
});

test("an agent without a host ID is issued one, told to pass it back, and keeps its name with it", async () => {
  const { path, cli } = await fixture();
  const first = await cli(["pending", path, "--actor", "Plain terminal"]);
  const id = first.data.agent.id as string;
  expect(id).toMatch(/^tether:[a-f0-9]{12}$/);
  expect(first.data.agent).toMatchObject({ issued: true, name: "Plain terminal" });
  expect(first.data.agent.next).toContain(`--agent-id ${id}`);
  expect((await cli(["pending", path, "--actor", "Plain terminal", "--agent-id", id])).ok).toBe(true);
  // Forgetting the ID is refused rather than silently splitting the agent in two.
  expect((await cli(["pending", path, "--actor", "Plain terminal"])).error).toMatchObject({ code: "agent_name_taken" });
  // An issued identity whose command failed is discarded, so its name stays free.
  expect((await cli(["pending", join(path, "..", "missing.md"), "--actor", "Fresh name"])).ok).toBe(false);
  expect((await cli(["pending", path, "--actor", "Fresh name", "--agent-id", "claude:other"])).ok).toBe(true);
});

test("turn waits are keyed by agent ID and the reader presses one agent by ID", async () => {
  const { path, daemon, api, cli } = await fixture();
  const waitA = cli(["turn", "wait", path, "--actor", "Builder"], agentA);
  const waitB = cli(["turn", "wait", path, "--actor", "Checker", "--timeout", "2"], agentB);
  const agents = async () => (await (await api("api/turns")).json() as { agents: Array<{ agentId: string; state: string }> }).agents;
  for (let i = 0; i < 100 && (await agents()).length < 2; i++) await Bun.sleep(20);
  expect(await agents()).toEqual([{ agentId: "claude:session-a", state: "ready" }, { agentId: "claude:session-b", state: "ready" }]);
  const identities = (await (await api("api/identities?ids=claude%3Asession-a,claude%3Asession-b")).json() as { identities: Array<{ name: string; icon: string }> }).identities;
  expect(identities.map(identity => identity.name)).toEqual(["Builder", "Checker"]);
  expect(identities[0]!.icon).not.toBe(identities[1]!.icon);
  expect(await (await api("api/turn", { method: "POST", body: JSON.stringify({ agentId: "claude:session-a" }) })).json()).toMatchObject({ signalId: expect.any(String), state: "working", cursor: `${daemon.instanceId}:1`, sequence: 1, agentId: "claude:session-a" });
  expect((await waitA).data).toMatchObject({ turn: { sequence: 1, path, agentId: "claude:session-a" } });
  expect((await waitB).data).toMatchObject({ turn: null });
});
