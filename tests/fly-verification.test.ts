import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { startSharedProfile } from "../src/server/shared-profile";

test("setup completion requires a verified browser and observed file access, not an agent report", async () => {
  const directory = await mkdtemp("/tmp/tether-fly-verification-");
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  const daemon = createDaemon({ config, web: () => new Response("reader") });
  let shared: Awaited<ReturnType<typeof startSharedProfile>> | undefined;
  try {
    await daemon.ready;
    shared = await startSharedProfile(daemon, { origin: "https://fly.example.test", port: 0, owner: "Owner", active: true });
    const path = join(directory, "document.md"); await writeFile(path, "# Verification\n");
    const document = await daemon.library.dispatch("document.register", { path, machineId: daemon.service.store.localMachineId }) as {documentId:string};
    const attempt = await shared.localControl("attempt", { answers: { hub: "Mac", machine: "", access: "browser", qualifyPaths: false, internet: true } }) as {id:string};
    await shared.localControl("password", { password: "unique fixture password for testing" });
    const status = await shared.localControl("status", {}) as {localPort:number};
    let cookie = "";
    const post = (route: string, body: object) => fetch(`http://127.0.0.1:${status.localPort}${route}`, { method: "POST", headers: { host: "fly.example.test", origin: "https://fly.example.test", "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const input = { id: attempt.id, documentId: document.documentId, internetConfirmed: true };
    expect((await post("/folio/api/fly/verify-attempt", input)).status).toBe(401);
    await expect(shared.localControl("verify-attempt", input)).rejects.toThrow("HTTPS Settings");
    const login = await post("/auth/password/login", { password: "unique fixture password for testing", name: "Verification browser" });
    expect(login.status).toBe(200); cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/folio/api/fly/verify-attempt", { ...input, internetConfirmed: false })).status).not.toBe(200);
    const verified = await post("/folio/api/fly/verify-attempt", input);
    expect(verified.status).toBe(200);
    const result = await verified.json();
    expect(result).toMatchObject({ phase: "verified", verification: { documentId: document.documentId, ownerConfirmedInternet: true, ownerConfirmedNative: false } });
    expect(result.verification.bodyRevision).toMatch(/^sha256:/);
    const clientId = crypto.randomUUID(), token = "a".repeat(43), machineId = daemon.service.store.localMachineId;
    daemon.service.store.db.query("INSERT INTO shared_clients(id,name,kind,machine_id,token_hash,created_at,expires_at) VALUES(?,?,'agent',?,?,?,?)")
      .run(clientId, "Paseo fixture", machineId, createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000);
    const agent = (operation: string, body: object) => fetch(`http://127.0.0.1:${status.localPort}/api/shared/${operation}`, { method: "POST", headers: { host: "fly.example.test", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await agent("reader.announce", { clientId, documentId: document.documentId, host: "cmux", workspaceId: "wrong-host" });
    const poll = await (await agent("plugin.poll", { folio: -1 })).json();
    expect(poll.intents).toEqual([]);
    expect((await (await agent("reader.receive", {})).json()).announcements).toHaveLength(1);
    const native = await shared.localControl("attempt", { answers: { hub: "Mac", machine: "Mac", access: "paseo", qualifyPaths: false, internet: false } }) as {id:string};
    const nativeInput = { id: native.id, documentId: document.documentId, machineId, clientId, nativeConfirmed: true };
    expect((await post("/folio/api/fly/verify-attempt", { ...nativeInput, nativeConfirmed: false })).status).not.toBe(200);
    const dispatch = daemon.library.dispatch;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    daemon.library.dispatch = async (operation, body) => { if (operation === "document.read") { entered(); await gate; } return dispatch(operation, body); };
    const pending = post("/folio/api/fly/verify-attempt", nativeInput);
    await reading; await shared.localControl("revoke", { clientId, confirmed: true }); release();
    expect((await pending).status).not.toBe(200);
    daemon.library.dispatch = dispatch;
    expect((await shared.localControl("status", {}) as any).attempts.find((attempt: any) => attempt.id === native.id).phase).not.toBe("verified");
    await shared.localControl("enabled", { enabled: false, confirmed: true });
    expect((await post("/folio/api/fly/verify-attempt", input)).status).toBe(401);
  } finally { await shared?.stop(); await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
});
