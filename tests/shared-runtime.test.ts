import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupState, restoreState } from "../src/cli/backup";
import { runCli } from "../src/cli/main";
import { bodyRevision } from "../src/core/index";
import type { HostAdapter } from "../src/hosts/host-adapter";
import { SharedAuth, type SharedCredential } from "../src/remote/shared-auth";
import { writeSharedCredential } from "../src/remote/shared-client";
import { assertSharedReaderLink, createReaderReceiver } from "../src/remote/reader-receiver";
import { prepareConfig, resolveConfig } from "../src/server/config";
import { controlRequest } from "../src/server/lifecycle";
import { createDaemon, startDaemon, type TetherDaemon } from "../src/server/server";
import { readSharedConfig, startSharedProfile, writeSharedConfig } from "../src/server/shared-profile";
import { cookieVerifier, ViewStore } from "../src/server/view-store";
import { PrivateStore } from "../src/storage/private-store";
import { writeRemoteBinding } from "../src/remote/binding";

test("a bound client profile cannot create a second authority through local management or daemon startup", async () => {
  const directory = await mkdtemp("/tmp/tether-bound-profile-"); directories.push(directory);
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  await writeRemoteBinding(config, { connection: join(directory, "private-connection.json"), receiver: "plugin" });
  for (const args of [["shared", "manage", "status", "--input", "{}"], ["startup", "enable"], ["cmux", "attach"]]) {
    const result = await runCli(args, { config });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result.response)).toContain("bound to a shared hub");
  }
  await expect(startDaemon({ config })).rejects.toThrow("cannot start a local library");
  expect(await Bun.file(join(config.configDir, "tether.sqlite")).exists()).toBe(false);
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const origin = "https://shared-runtime.example.test";

async function backupFixture() {
  const directory = await mkdtemp("/tmp/tether-shared-runtime-"); directories.push(directory);
  const config = resolveConfig({ profile: "test", configDir: join(directory, "original"), runtimeDir: join(directory, "original-runtime") });
  await prepareConfig(config);
  const path = join(directory, "document.md"); await writeFile(path, "Body\n");
  const store = new PrivateStore(join(config.configDir, "tether.sqlite"));
  const document = store.ensureDocument(path);
  store.appendEvent({ path, event: { type: "comment", id: "comment", seq: 1, actor: "human", createdAt: new Date().toISOString(), body: "Retained review", anchor: { exact: "Body", prefix: "", suffix: "\n", projectionStart: 0, projectionEnd: 4, bodyRevision: bodyRevision("Body\n") } }, operationId: "review-operation", payloadHash: "review-payload" });
  const observed = store.observe(path, "agent", 1, bodyRevision("Body\n"));
  store.acknowledge(path, "agent", "assistant", observed.cursor);
  const views = new ViewStore(store.db);
  views.put({ id: "old-view", kind: "document", path, verifier: cookieVerifier("test-only-cookie"), createdAt: Date.now() });
  views.saveDraft("old-view", { body: "Unsubmitted local draft", baseRevision: bodyRevision("Body\n"), scroll: 12, updatedAt: Date.now() });
  views.savePosition("old-view", 12, 110);
  new SharedAuth({ db: store.db, origin, passkeys: {
    enrolled: () => false, registrationOptions: async () => { throw new Error("Unused"); },
    authenticationOptions: async () => { throw new Error("Unused"); }, register: async () => {}, authenticate: async () => {},
  } });
  const token = "a".repeat(43), clientId = crypto.randomUUID();
  store.db.query("INSERT INTO shared_clients(id,name,kind,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(clientId, "Retained agent", "agent", createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 86_400_000);
  const machineId = store.localMachineId;
  store.close();
  await writeSharedConfig(config, { origin, port: 19997, owner: "Test owner", active: true });
  const credential: SharedCredential = { origin, token, clientId, machineId: null, expiresAt: Date.now() + 86_400_000 };
  await writeSharedCredential(join(config.configDir, "device-connection.json"), credential);
  const backup = join(directory, "backup"); await backupState(config, backup);
  const restored = resolveConfig({ profile: "test", configDir: join(directory, "restored"), runtimeDir: join(directory, "restored-runtime") });
  await restoreState(backup, restored.configDir);
  return { directory, backup, restored, document, machineId, clientId, observed };
}

test("restored authority stays fenced until confirmation and changing machines clears only local reader grants", async () => {
  const f = await backupFixture();
  expect((await readSharedConfig(f.restored))?.active).toBe(false);
  await expect(startDaemon({ config: f.restored, web: () => new Response("Unused") })).rejects.toThrow("fenced");
  expect((await runCli(["shared", "activate"], { config: f.restored })).exitCode).toBe(2);
  expect((await readSharedConfig(f.restored))?.active).toBe(false);
  expect((await runCli(["shared", "configure", "--origin", origin, "--port", "19998"], { config: f.restored })).exitCode).toBe(0);
  expect((await readSharedConfig(f.restored))?.active).toBe(false);
  const activated = await runCli(["shared", "activate", "--confirm"], { config: f.restored });
  expect(activated).toMatchObject({ exitCode: 0, response: { data: { active: true, previousMachineId: f.machineId, sameFileMachine: false } } });
  const copy = new PrivateStore(join(f.restored.configDir, "tether.sqlite"));
  try {
    expect(copy.localMachineId).not.toBe(f.machineId);
    expect(copy.documentById(f.document.id)).toMatchObject({ machine_id: f.machineId, path: f.document.path });
    expect(copy.events({ documentId: f.document.id })).toHaveLength(1);
    expect(copy.lookupMutation({ documentId: f.document.id }, "review-operation").outcome).toBe("applied");
    expect(copy.acknowledgement({ documentId: f.document.id }, "agent")).toMatchObject({ cursor: f.observed.cursor });
    expect(copy.db.query("SELECT id,revoked_at FROM shared_clients").all()).toEqual([{ id: f.clientId, revoked_at: null }]);
    for (const table of ["reader_views", "reader_drafts", "reader_positions", "reader_zoom"]) expect(copy.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(copy.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const nextMachineId = copy.localMachineId;
    expect((await runCli(["shared", "activate", "--confirm"], { config: f.restored })).response).toMatchObject({ data: { active: true, changed: false } });
    expect(copy.db.query("SELECT value FROM settings WHERE key='local_machine_id'").get()).toEqual({ value: nextMachineId });
  } finally { copy.close(); }
  const manifest = JSON.parse(await readFile(join(f.backup, "manifest.json"), "utf8"));
  expect(manifest.files["device-connection.json"]).toBeUndefined();
  expect((await stat(join(f.restored.configDir, "tether.sqlite"))).mode & 0o777).toBe(0o600);
});

test("explicit same-file-machine restore preserves identity and valid local view state", async () => {
  const f = await backupFixture();
  expect((await runCli(["shared", "activate", "--confirm", "--same-file-machine"], { config: f.restored })).exitCode).toBe(0);
  const copy = new PrivateStore(join(f.restored.configDir, "tether.sqlite"));
  try {
    expect(copy.localMachineId).toBe(f.machineId);
    expect(copy.documentById(f.document.id)?.machine_id).toBe(f.machineId);
    const views = new ViewStore(copy.db);
    expect(views.list()).toHaveLength(1);
    expect(views.draft("old-view")?.body).toBe("Unsubmitted local draft");
    expect(views.position("old-view")).toBe(12);
  } finally { copy.close(); }
});

async function receiverFixture() {
  const directory = await mkdtemp("/tmp/tether-receiver-runtime-"); directories.push(directory);
  const connection = join(directory, "connection.json");
  const credential: SharedCredential = { origin, token: "b".repeat(43), clientId: crypto.randomUUID(), machineId: null, expiresAt: Date.now() + 86_400_000 };
  await writeSharedCredential(connection, credential);
  const documentId = crypto.randomUUID();
  const announcement = { id: crypto.randomUUID(), documentId, url: `${origin}/reader/d/${documentId}/`, origin: "agent", host: "wave", expiresAt: Date.now() + 300_000 };
  return { connection, credential, announcement, config: resolveConfig({ profile: "test", configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") }) };
}

test("receiver emits a credential-free public link before acknowledging and never invokes a native host", async () => {
  const f = await receiverFixture(), steps: string[] = [], outputs: string[] = [];
  let nativeCalls = 0;
  const host: HostAdapter = { id: "wave", detect: async () => { nativeCalls++; return true; }, capabilities: () => { nativeCalls++; return { embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: false }; }, openView: async () => { nativeCalls++; }, openExternal: async () => { nativeCalls++; } };
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, callback: (error?: Error | null) => void) => {
    outputs.push(String(chunk)); steps.push("output"); callback(); return true;
  }) as typeof process.stdout.write);
  const request = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); expect(url.startsWith(origin)).toBe(true);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${f.credential.token}`);
    if (url.endsWith("reader.receive")) return Response.json({ announcements: [f.announcement] });
    expect(url.endsWith("reader.acknowledge")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ ids: [f.announcement.id] });
    steps.push("acknowledge"); return Response.json({ acknowledged: true });
  }) as typeof fetch);
  try {
    const result = await runCli(["remote", "receive", "--connection", f.connection, "--host", "wave", "--once"], { config: f.config, host });
    expect(result).toMatchObject({ exitCode: 0, response: { data: { delivered: 1 } } });
    expect(steps).toEqual(["output", "acknowledge"]); expect(nativeCalls).toBe(0);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ command: "reader.announcement", data: { url: f.announcement.url, placement: "link_available", nativePlacement: "unsupported", requestedHost: "wave" } });
    expect(outputs.join("")).not.toContain(f.credential.token); expect(outputs.join("")).not.toContain("ticket=");
  } finally { request.mockRestore(); write.mockRestore(); }
});

test("failed receiver output keeps the announcement unacknowledged", async () => {
  const f = await receiverFixture(); let acknowledgements = 0;
  const write = spyOn(process.stdout, "write").mockImplementation(((_chunk: string | Uint8Array, callback: (error?: Error | null) => void) => { callback(new Error("Output closed")); return false; }) as typeof process.stdout.write);
  const request = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    if (String(input).endsWith("reader.receive")) return Response.json({ announcements: [f.announcement] });
    acknowledgements++; return Response.json({ acknowledged: true });
  }) as typeof fetch);
  try {
    expect((await runCli(["remote", "receive", "--connection", f.connection, "--once"], { config: f.config })).exitCode).toBe(1);
    expect(acknowledgements).toBe(0);
  } finally { request.mockRestore(); write.mockRestore(); }
});

test("Paseo shared reader enqueue requires a private connection and cannot inherit remote origin or target authority", async () => {
  const f = await receiverFixture();
  const daemon = createDaemon({ config: f.config, web: () => new Response("Unused") });
  try {
    await daemon.ready;
    const control = <T>(operation: string, body: Record<string, unknown>) => controlRequest<T>(f.config, `/control/hosts/paseo/${operation}`, body, { start: false });
    const target = { host: "paseo", workspaceId: "local-receiver-workspace" };
    const reader = { origin, documentId: f.announcement.documentId, url: f.announcement.url };
    await control("wait", { after: 0, folio: -1, timeoutMs: 0 });
    await expect(control("reader", { reader, target })).rejects.toThrow();
    await expect(control("reader", { connectionPath: f.connection, reader: { ...reader, url: reader.url.replace(origin, "https://attacker.example.test") }, target })).rejects.toThrow();
    await chmod(f.connection, 0o644);
    await expect(control("reader", { connectionPath: f.connection, reader, target })).rejects.toThrow();
    await chmod(f.connection, 0o600);
    await expect(control("reader", { connectionPath: f.connection, reader, target: { host: "cmux", workspaceId: "wrong-host" } })).rejects.toThrow();
    await control("enqueue", { kind: "document", origin: "agent", path: "/local/example.md", sharedReader: reader, target });
    const authorized = await control<{ id: string; origin: string }>("reader", { connectionPath: f.connection, reader, target, origin: "user" });
    expect(authorized.origin).toBe("agent");
    const batch = await control<{ intents: Array<{ id: string; origin: string; target: unknown; sharedReader?: unknown; path?: string }> }>("wait", { after: 0, folio: -1, timeoutMs: 0 });
    expect(batch.intents).toHaveLength(2);
    expect(batch.intents.find(item => item.path === "/local/example.md")?.sharedReader).toBeUndefined();
    expect(batch.intents.find(item => item.id === authorized.id)).toMatchObject({ origin: "agent", target, sharedReader: reader });
    expect(JSON.stringify(batch)).not.toContain(f.credential.token);
  } finally { await daemon.stop(); }
});

test("receiving authority captures the local target and rejects sender-supplied human origin", async () => {
  const f = await receiverFixture();
  const target = { host: "paseo", workspaceId: "local-workspace" };
  const received: unknown[] = [];
  const host: HostAdapter = {
    id: "paseo", detect: async () => true, capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: false }),
    launchTarget: () => target, openView: async () => { throw new Error("Ordinary opens must not receive announcements."); }, openExternal: async () => {},
    receiveReader: async request => { assertSharedReaderLink(request.reader); received.push(request.target); return { placement: "announced" }; },
  };
  const receiver = createReaderReceiver({ origin, host });
  target.workspaceId = "later-local-workspace";
  await expect(receiver.deliver({ ...f.announcement, origin: "user" } as unknown as Parameters<typeof receiver.deliver>[0])).rejects.toThrow("invalid or expired");
  await expect(receiver.deliver({ ...f.announcement, url: f.announcement.url.replace(origin, "https://attacker.example.test") } as Parameters<typeof receiver.deliver>[0])).rejects.toThrow("configured HTTPS");
  const announcement = { ...f.announcement, origin: "agent" as const, target: { host: "paseo", workspaceId: "sender-workspace" } };
  expect(await receiver.deliver(announcement)).toMatchObject({ placement: "announced", nativePlacement: "supported" });
  expect(received).toEqual([{ host: "paseo", workspaceId: "local-workspace" }]);
});

test("shared shutdown drains admitted dispatches before releasing reader resources or the caller's database", async () => {
  const directory = await mkdtemp("/tmp/tether-shared-shutdown-"); directories.push(directory);
  const config = resolveConfig({ profile: "test", configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  await prepareConfig(config);
  const store = new PrivateStore(join(config.configDir, "tether.sqlite"));
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let stopped = false, completed = false, readerClosed = false;
  const daemon = { config, service: { store, registerFileAccess: () => {} }, library: {
    dispatch: async () => {
      enter(); await blocked;
      expect(readerClosed).toBe(false);
      store.db.query("INSERT INTO settings(key,value) VALUES('completed_shared_operation','yes')").run();
      completed = true; return { completed: true };
    },
    reader: { open: async () => ({ request: async () => Response.json({ opened: true }), close: async () => { readerClosed = true; } }) },
    page: async () => null, subscribe: () => () => {},
  } } as unknown as TetherDaemon;
  const shared = await startSharedProfile(daemon, { origin, port: 0, owner: "Test owner", active: true });
  const token = "c".repeat(43);
  store.db.query("INSERT INTO shared_clients(id,name,kind,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(crypto.randomUUID(), "Shutdown test", "agent", createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000);
  const { localPort } = await shared.localControl("status", {}) as { localPort: number };
  const headers = { host: new URL(origin).host, authorization: `Bearer ${token}`, "content-type": "application/json" };
  const endpoint = `http://127.0.0.1:${localPort}`;
  let pending: Promise<Response | null> | undefined;
  try {
    expect((await fetch(`${endpoint}/reader/d/test-document/`, { headers })).status).toBe(200);
    pending = fetch(`${endpoint}/api/shared/document.save`, { method: "POST", headers, body: "{}" }).catch(() => null);
    await entered;
    const firstStop = shared.stop();
    expect(shared.stop()).toBe(firstStop);
    void firstStop.then(() => { stopped = true; });
    await Bun.sleep(20);
    expect(stopped).toBe(false); expect(completed).toBe(false); expect(readerClosed).toBe(false);
    release(); await firstStop;
    expect(completed).toBe(true); expect(readerClosed).toBe(true);
    expect(store.db.query("SELECT value FROM settings WHERE key='completed_shared_operation'").get()).toEqual({ value: "yes" });
  } finally { release(); await shared.stop(); await pending; store.close(); }
}, 20_000);
