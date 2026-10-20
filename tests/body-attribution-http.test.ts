import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { readControlToken, resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";
import { bodyRevision } from "../src/core/index";
import { HUMAN_ID } from "../src/shared/agent-identity";

test("reader revision API connects host turns, signed saves, role takeover and restart gaps", async () => {
  const directory = await mkdtemp("/tmp/tether-attribution-http-"), path = join(directory, "doc.md");
  await writeFile(path, "# Base\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let daemon = createDaemon({ config, startupGraceMs: 600_000 });
  await daemon.ready;
  const cli = async (args: string[], session = "alice") => {
    const result = await runCli(args, { config, env: { PASEO_AGENT_ID: session, TETHER_PASEO_HOST_ID: "host" } });
    expect(result.exitCode).toBe(0);
    return (result.response as any).data;
  };
  const control = async (input: object) => {
    const token = await readControlToken(config);
    const response = await fetch(`${daemon.origin}/control/turn/adapter`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const value = await response.json() as any;
    expect(response.ok).toBe(true);
    return value.data ?? value;
  };
  const reader = async () => {
    const ticket = daemon.mintTicket(await daemon.service.open(path));
    const launch = await fetch(ticket.url, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";", 1)[0]!;
    const base = `${daemon.origin}${launch.headers.get("location")!}`;
    return async (route: string, body?: unknown, method = body ? "POST" : "GET") => {
      const response = await fetch(new URL(route, base), { method, headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.ok).toBe(true);
      return await response.json() as any;
    };
  };
  try {
    let api = await reader();
    const initial = (await api("api/bootstrap")).document.bodyRevision;
    const registration = await cli(["turn", "register", path, "--actor", "Alice"]);
    const identity = registration.identity;
    const lease = await control({ action: "lease", hostId: "host", instance: "adapter" });
    const signal = await api("api/turn", { agentId: identity.id, operationId: "attribution-turn" });
    const receipt = (action: string) => control({ action, hostId: "host", token: lease.token, signalId: signal.signalId });
    await receipt("claim");
    await receipt("accepted");
    await writeFile(path, "# Alice first\n");
    const open = await api(`api/revisions?from=${initial}`);
    expect(open.revisions[0]).toMatchObject({ authorId: identity.id, open: true });
    await writeFile(path, "# Alice final\n");
    await receipt("completed"); // The final write must be captured without a reader poll.
    let chain = await api(`api/revisions?from=${initial}`);
    expect(chain.revisions).toHaveLength(1);
    expect(chain.revisions[0]).toMatchObject({ body: "# Alice final\n", authorId: identity.id, open: false });
    await cli(["turn", "takeover", path, "--role-id", identity.id, "--expected-recipient", identity.id], "replacement");
    const bodyFile = join(directory, "save.txt"); await writeFile(bodyFile, "# Replacement\n");
    await cli(["document", "save", path, "--body-file", bodyFile, "--expected-body-revision", bodyRevision("# Alice final\n")], "replacement");
    const retired = await runCli(["document", "save", path, "--body-file", bodyFile, "--expected-body-revision", bodyRevision("# Replacement\n")],
      { config, env: { PASEO_AGENT_ID: "alice", TETHER_PASEO_HOST_ID: "host" } });
    expect(retired.exitCode).not.toBe(0);
    expect((retired.response as any).error.code).toBe("agent_role_reassigned");
    chain = await api(`api/revisions?from=${initial}`);
    expect(chain.revisions.at(-1).authorId).toBe(identity.id);
    const resolved = await api(`api/identities?ids=${encodeURIComponent(identity.id)}`);
    expect(resolved.identities[0]).toEqual(identity);
    const renamed = await api("api/identities/rename", { id: identity.id, name: "Reviewer" });
    expect(renamed.identity.colorSlot).toBe(identity.colorSlot);
    expect(renamed.identity.icon).toBe(identity.icon);
    expect(renamed.identityRevision).toBeGreaterThan(resolved.identityRevision);
    await api("api/file", { content: "# Human edit\n", expectedBodyRevision: bodyRevision("# Replacement\n") }, "PUT");
    expect((await api(`api/revisions?from=${initial}`)).revisions.at(-1).authorId).toBe(HUMAN_ID);
    await daemon.stop();
    await writeFile(path, "# While offline\n");
    daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
    api = await reader();
    chain = await api(`api/revisions?from=${initial}`);
    expect(chain.revisions.at(-1)).toMatchObject({ body: "# While offline\n", authorId: null, open: false });
    expect(chain.revisions.map((r: any) => r.authorId)).toEqual([identity.id, identity.id, HUMAN_ID, null]);
    expect((await api(`api/revisions?from=${bodyRevision("pruned")}`)).base).toBeNull();
    expect((await api("api/reviewed", { bodyRevision: bodyRevision("# While offline\n") })).saved).toBe(true);
  } finally { await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
});
