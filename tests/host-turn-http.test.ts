import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig, readControlToken } from "../src/server/config";
import { runCli } from "../src/cli/main";

test("clipboard prompts and CLI takeover preserve identity everywhere and sign new-session reviews as the role", async () => {
  const directory = await mkdtemp("/tmp/tether-takeover-http-");
  const path = join(directory, "document.md"), other = join(directory, "other.md");
  await writeFile(path, "# Role\n"); await writeFile(other, "# Other\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let daemon = createDaemon({ config, startupGraceMs: 600_000 });
  await daemon.ready;
  const cli = async (args: string[], session = "old") => (await runCli(args, { config, env: { PASEO_AGENT_ID: session, TETHER_PASEO_HOST_ID: "host" } })).response as any;
  try {
    const ticket = daemon.mintTicket(await daemon.service.open(path));
    const launch = await fetch(ticket.url, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
    const base = `${daemon.origin}${launch.headers.get("location")!}`;
    const prompt = async (suffix = "") => {
      const response = await fetch(new URL(`api/turn-prompt${suffix}`, base), { headers: { cookie } });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await prompt()).body.prompt).toContain("--if-empty");
    const registered = await cli(["turn", "register", path, "--actor", "Builder", "--label", "Main build", "--icon", "flame", "--if-empty"]);
    expect(registered.ok).toBe(true);
    expect(registered.data.identity.icon).toBe("flame");
    const identity = registered.data.identity;
    expect((await cli(["turn", "register", path, "--actor", "Other", "--if-empty"], "intruder")).error.code).toBe("turn_slot_filled");
    expect((await prompt()).status).toBe(400);
    expect((await prompt("?agentId=paseo%3Aold")).body.prompt).toContain("--role-id 'paseo:old' --expected-recipient 'paseo:old'");
    expect((await cli(["turn", "register", other, "--actor", "Builder"])).ok).toBe(true);
    const args = ["turn", "takeover", path, "--role-id", "paseo:old", "--expected-recipient", "paseo:old"];
    const taken = await cli(args, "new");
    expect(taken.ok).toBe(true);
    expect(taken.data.identity).toEqual(identity);
    expect(taken.data.registrations).toHaveLength(2);
    expect((await cli(args, "new")).ok).toBe(true); // Lost-response retry.
    expect((await cli(args, "third")).error.code).toBe("agent_role_changed");
    expect((await cli(["pending", path, "--actor", "Retired"], "old")).error.code).toBe("agent_role_reassigned");
    expect((await cli(["pending", path, "--actor", "Replacement"], "new")).ok).toBe(true);
    const note = join(directory, "reply.txt"); await writeFile(note, "Replacement's note.");
    const comment = await cli(["comment", path, "--actor", "Replacement", "--quote", "Role", "--body-file", note, "--operation-id", "new-note"], "new");
    expect(comment.ok).toBe(true);
    const threads = await cli(["threads", path], "new");
    expect(JSON.stringify(threads)).toContain('"actor":"paseo:old"');
    expect(daemon.service.store.identities.resolve(["paseo:old"])[0]).toEqual(identity);
    expect(daemon.hostTurns.subscriptions().every(s => s.recipientId === "paseo:new")).toBe(true);
    await daemon.stop();
    daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
    expect(daemon.service.store.identities.signingId("paseo:new")).toBe("paseo:old");
    expect(daemon.hostTurns.subscriptions().every(s => s.recipientId === "paseo:new")).toBe(true);
  } finally { await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("CLI registration, reader events, idempotent sends and adapter receipts use one durable authority", async () => {
  const directory = await mkdtemp("/tmp/tether-host-turn-http-"), path = join(directory, "document.md");
  await writeFile(path, "# Test\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let daemon = createDaemon({ config, startupGraceMs: 600_000 });
  await daemon.ready;
  const call = async (action: string, input: object) => {
    const token = await readControlToken(config);
    const response = await fetch(`${daemon.origin}/control/turn/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result as any;
  };
  try {
    const registered = await runCli(["turn", "register", path, "--actor", "Adapter test", "--host-id", "host"], { config, env: { PASEO_AGENT_ID: "agent" } });
    expect(registered.exitCode).toBe(0);
    const state = await call("status", { path });
    expect(state.agents[0].agentId).toBe("paseo:agent");
    const lease = await call("adapter", { action: "lease", hostId: "host", instance: "worker" });
    expect(typeof lease.token).toBe("string");
    const sent = await call("send", { path, agentId: "paseo:agent", operationId: "human-operation" });
    expect(sent.state).toBe("pending");
    expect((await call("send", { path, agentId: "paseo:agent", operationId: "human-operation" })).signalId).toBe(sent.signalId);
    await call("adapter", { action: "claim", hostId: "host", token: lease.token, signalId: sent.signalId, position: { epoch: "session", seq: 0 } });
    await daemon.stop();
    daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
    expect((await call("status", { path })).agents[0].state).toBe("unavailable");
    const restored = await call("adapter", { action: "lease", hostId: "host", instance: "worker" });
    await call("adapter", { action: "accepted", hostId: "host", token: restored.token, signalId: sent.signalId });
    await call("adapter", { action: "completed", hostId: "host", token: restored.token, signalId: sent.signalId });
    expect((await call("status", { path })).agents[0].state).toBe("ready");
    expect((await runCli(["turn", "send", path, "--agent-id", "paseo:agent", "--operation-id", "agent-send"], { config, env: { PASEO_AGENT_ID: "agent" } })).exitCode).not.toBe(0);
  } finally { await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
});
