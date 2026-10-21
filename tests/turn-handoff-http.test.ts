import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";
import { TurnHandoffs } from "../src/server/turn-handoffs";

async function fixture() {
  const directory = await mkdtemp("/tmp/tether-handoffs-"), path = join(directory, "doc.md");
  await writeFile(path, "# Garden editor\n\nReview this.\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
  const cli = async (args: string[], session = "agent") => (await runCli(args, { config, env: { PASEO_AGENT_ID: session, TETHER_PASEO_HOST_ID: "host" } })).response as any;
  const lease = () => daemon.hostTurns.lease("local", "host", "plugin");
  async function prompt(role?: string, additional = false) {
    const ticket = daemon.mintTicket(await daemon.service.open(path));
    const launch = await fetch(ticket.url, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
    const base = `${daemon.origin}${launch.headers.get("location")!}`;
    const response = await fetch(new URL(`api/turn-prompt${additional ? "?add=1" : role ? `?agentId=${encodeURIComponent(role)}` : ""}`, base), { headers: { cookie } });
    expect(response.ok).toBe(true);
    const { prompt } = await response.json() as { prompt: string };
    expect(prompt.split("\n\n")).toHaveLength(2);
    const handoff = /handoff:[a-f0-9-]{36}/.exec(prompt)![0];
    return { prompt, handoff };
  }
  return { directory, path, config, cli, lease, prompt, get daemon() { return daemon; },
    async restart() { await daemon.stop(); daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready; },
    async close() { await daemon.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test("one copied assignment command creates identity, retrieves review context, and resumes after restart", async () => {
  const f = await fixture();
  try {
    const { handoff, prompt } = await f.prompt();
    expect(prompt).toContain("turn assign");
    expect((await f.cli(["turn", "assign", handoff])).error.code).toBe("turn_host_unavailable");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
    f.lease();
    const note = join(f.directory, "note.txt"); await writeFile(note, "Please review.");
    expect((await f.cli(["comment", f.path, "--actor", "human", "--quote", "Review this.", "--body-file", note, "--operation-id", "note"], "human")).ok).toBe(true);
    const applied = await f.cli(["turn", "assign", handoff]);
    expect(applied.ok).toBe(true);
    expect(applied.data.identity.name).toBe("Garden editor");
    expect(applied.data.identity.icon).toBeTruthy();
    expect(applied.data.identity.colorSlot).toBeGreaterThan(0);
    expect(applied.data.context.document.body).toContain("# Garden editor");
    expect(applied.data.context.threads).toHaveLength(1);
    expect(applied.data.context.pending.reviewState).toBe("never_reviewed");
    expect((await f.cli(["turn", "assign", handoff])).data.identity).toEqual(applied.data.identity);
    expect((await f.cli(["turn", "assign", handoff], "other")).error.code).toBe("handoff_used");
    await f.restart();
    // A read-only resume works even before the host reconnects.
    const resumed = await f.cli(["turn", "resume", handoff]);
    expect(resumed.ok).toBe(true);
    expect(resumed.data.context.pending.reviewState).toBe("never_reviewed");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
  } finally { await f.close(); }
});

test("competing empty-slot handoffs cannot replace each other and explicit names/icons work", async () => {
  const f = await fixture();
  try {
    f.lease();
    const a = await f.prompt(), b = await f.prompt();
    const outcomes = await Promise.all([
      f.cli(["turn", "assign", a.handoff, "--name", "Builder", "--icon", "flame"], "a"),
      f.cli(["turn", "assign", b.handoff, "--name", "Second", "--icon", "balloon"], "b"),
    ]);
    expect(outcomes.filter(r => r.ok)).toHaveLength(1);
    expect(outcomes.find(r => !r.ok).error.code).toBe("turn_slot_filled");
    const winner = outcomes.find(r => r.ok);
    expect(["Builder", "Second"]).toContain(winner.data.identity.name);
    expect(["flame", "balloon"]).toContain(winner.data.identity.icon);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
  } finally { await f.close(); }
});

test("short takeover is global, preserves identity, and stale/replayed handoffs never restore a retired receiver", async () => {
  const f = await fixture();
  try {
    f.lease();
    const other = join(f.directory, "other.md"); await writeFile(other, "# Other\n");
    await f.cli(["turn", "register", f.path, "--actor", "Original", "--icon", "flame"], "old");
    await f.cli(["turn", "register", other, "--actor", "Original"], "old");
    const a = await f.prompt("paseo:old"), stale = await f.prompt("paseo:old");
    expect(a.prompt).toContain("turn takeover");
    const applied = await f.cli(["turn", "takeover", a.handoff], "new");
    expect(applied.ok).toBe(true);
    expect(applied.data.identity.name).toBe("Original");
    expect(applied.data.identity.icon).toBe("flame");
    expect(applied.data.registrations).toHaveLength(2);
    expect((await f.cli(["turn", "takeover", a.handoff], "new")).ok).toBe(true);
    expect((await f.cli(["turn", "takeover", stale.handoff], "third")).error.code).toBe("agent_role_changed");
    const next = await f.prompt("paseo:old");
    expect((await f.cli(["turn", "takeover", next.handoff], "third")).ok).toBe(true);
    expect((await f.cli(["turn", "takeover", a.handoff], "new")).error.code).toBe("agent_role_changed");
    expect(f.daemon.hostTurns.subscriptions().every(s => s.recipientId === "paseo:third")).toBe(true);
  } finally { await f.close(); }
});

test("failed onboarding reports applied registration and resume retrieves context without another mutation", async () => {
  const f = await fixture();
  try {
    f.lease(); const { handoff } = await f.prompt();
    const read = f.daemon.service.read.bind(f.daemon.service);
    f.daemon.service.read = async () => { throw new Error("File temporarily unavailable"); };
    const result = await f.cli(["turn", "assign", handoff, "--name", "Builder"]);
    expect(result.ok).toBe(true);
    expect(result.data.outcome).toBe("applied");
    expect(result.data.warnings[0].code).toBe("onboarding_incomplete");
    expect(result.data.resume).toEqual(["turn", "resume", handoff]);
    f.daemon.service.read = read;
    expect((await f.cli(result.data.resume)).data.context.document.body).toContain("Garden editor");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
  } finally { await f.close(); }
});

test("expired handoffs and commands without a Paseo session fail before mutation", async () => {
  const f = await fixture();
  try {
    const doc = await f.daemon.service.open(f.path);
    const store = new TurnHandoffs(f.daemon.service.store.db, () => 0);
    const expired = store.create({ documentId: doc.documentId!, kind: "assign" });
    expect((await f.cli(["turn", "assign", expired.id])).error.code).toBe("handoff_expired");
    const { handoff } = await f.prompt();
    const result = await runCli(["turn", "assign", handoff], { config: f.config, env: { TETHER_PASEO_HOST_ID: "host" } });
    expect(result.exitCode).toBe(2);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
  } finally { await f.close(); }
});

test("a lost mutation response is retried once using its durable receipt", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    f.lease(); const { handoff } = await f.prompt(); let requests = 0;
    globalThis.fetch = Object.assign(async (input: any, init?: any) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/control/turn/assign") && ++requests === 1) {
        await response.arrayBuffer();
        return new Response('{"identity":', { status: 200 });
      }
      return response;
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const applied = await f.cli(["turn", "assign", handoff]);
    expect(applied.ok).toBe(true);
    expect(requests).toBe(2);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
    expect(applied.data.context.pending.reviewState).toBe("never_reviewed");
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("blocked verification reports the permission boundary without claiming the daemon is down", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    const { handoff } = await f.prompt();
    globalThis.fetch = Object.assign(async (input: any, init?: any) => {
      if (String(input).endsWith("/health")) throw Object.assign(new Error("Blocked socket"), { code: "EPERM" });
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const result = await f.cli(["turn", "assign", handoff]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("daemon_unreachable");
    expect(result.error.details.outcome).toBe("not_applied");
    expect(result.error.details.instructions[0]).toContain("daemon may still be healthy");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("failed verification after a lost response preserves outcome_unknown", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    f.lease(); const { handoff } = await f.prompt(); let applied = false;
    globalThis.fetch = Object.assign(async (input: any, init?: any) => {
      if (applied && String(input).endsWith("/health")) throw new Error("Connection interrupted");
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/control/turn/assign")) {
        await response.arrayBuffer(); applied = true;
        return new Response('{"identity":');
      }
      return response;
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const result = await f.cli(["turn", "assign", handoff]);
    expect(result.ok).toBe(false);
    expect(result.error.details.outcome).toBe("outcome_unknown");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
    globalThis.fetch = originalFetch;
    expect((await f.cli(["turn", "resume", handoff])).ok).toBe(true);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("assignment preserves a caller's existing identity on another document", async () => {
  const f = await fixture();
  try {
    f.lease(); const other = join(f.directory, "other.md"); await writeFile(other, "# Other\n");
    const original = await f.cli(["turn", "register", other, "--actor", "Named by agent", "--icon", "flame"]);
    const { handoff } = await f.prompt();
    const applied = await f.cli(["turn", "assign", handoff, "--name", "Ignored", "--icon", "balloon"]);
    expect(applied.data.identity).toEqual(original.data.identity);
  } finally { await f.close(); }
});

test("shared handoffs preserve the configured transport and receiver without treating the reference as a path", async () => {
  const { remoteControl } = await import("../src/cli/remote");
  const { parseCommand } = await import("../src/cli/commands");
  const originalFetch = globalThis.fetch;
  const handoff = `handoff:${crypto.randomUUID()}`;
  try {
    globalThis.fetch = Object.assign(async (input: any, init?: any) => {
      expect(String(input)).toBe("https://library.example.test/api/shared/turn.assign");
      expect(JSON.parse(init.body)).toEqual({ handoff, agentId: "paseo:agent", hostId: "host", receiver: "plugin" });
      return Response.json({ identity: { name: "Shared role" } });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const result: any = await remoteControl({ origin: "https://library.example.test", clientId: "agent", machineId: null, token: "a".repeat(43), expiresAt: Date.now() + 60000 },
      parseCommand(["turn", "assign", handoff]), "/control/turn/assign", { handoff, agentId: "paseo:agent", hostId: "host", receiver: "plugin" });
    expect(result.identity.name).toBe("Shared role");
  } finally { globalThis.fetch = originalFetch; }
});

test("shared receipt recovery requires the same owner and reports an ID-based review reference", async () => {
  const f = await fixture();
  try {
    f.daemon.hostTurns.lease("receiver", "host", "plugin");
    const { handoff } = await f.prompt();
    const input = { handoff, agentId: "paseo:shared", hostId: "host" };
    const result: any = await f.daemon.turnOperation("assign", input, "receiver");
    expect(result.document).toMatch(/^id:/);
    await expect(f.daemon.turnOperation("resume", input, "different-receiver")).rejects.toMatchObject({ code: "handoff_used" });
    expect((await f.daemon.turnOperation("resume", input, "receiver") as any).identity).toEqual(result.identity);
  } finally { await f.close(); }
});


test("add-agent handoff creates a separate Go identity without replacing the existing role", async () => {
  const f = await fixture();
  try {
    f.lease();
    const original = await f.cli(["turn", "register", f.path, "--actor", "Original", "--icon", "flame"]);
    const { prompt, handoff } = await f.prompt(undefined, true);
    expect(prompt).toContain("another agent");
    expect((await f.cli(["turn", "assign", handoff])).error.code).toBe("agent_already_registered");
    const added = await f.cli(["turn", "assign", handoff], "second");
    expect(added.ok).toBe(true);
    expect(added.data.identity.id).not.toBe(original.data.identity.id);
    expect(added.data.identity.icon).not.toBe(original.data.identity.icon);
    expect(f.daemon.service.store.identities.find(original.data.identity.id)).toEqual(original.data.identity);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(2);
    expect((await f.cli(["turn", "assign", handoff], "second")).ok).toBe(true);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(2);
  } finally { await f.close(); }
});
