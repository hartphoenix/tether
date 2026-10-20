import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig, readControlToken } from "../src/server/config";
import { runCli } from "../src/cli/main";

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
