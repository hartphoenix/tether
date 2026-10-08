import { sourceRevision } from "./build-revision";
import { SetupAttempts } from "../remote/setup-attempts";
import { hostname } from "node:os";
import { join } from "node:path";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import type { TetherDaemon } from "./server";
import type { TetherConfig } from "./config";
import { FilePasskeys } from "../remote/passkeys";
import { SharedAuth, sharedOrigin, type SharedClient } from "../remote/shared-auth";
import { SharedGateway } from "../remote/shared-gateway";
import { ConnectorBroker } from "../remote/connector";
import { ReaderDelivery } from "../remote/reader-delivery";
import { createDiagramRenderer } from "../remote/diagram-renderer";
import { documentDiagrams } from "../remote/document-diagrams";
import { diagramPalette, parseDiagramPalette } from "../shared/diagram-theme";
import { builtInDesign, tetherDesign } from "../shared/themes";

export type SharedProfileConfig = { origin: string; port: number; owner: string; active: boolean };
export async function readSharedConfig(config: TetherConfig): Promise<SharedProfileConfig | null> {
  const path = join(config.configDir, "shared-profile.json");
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("Shared profile configuration must be a private regular file.");
  return validateSharedConfig(JSON.parse(await readFile(path, "utf8")));
}
export function validateSharedConfig(value: SharedProfileConfig): SharedProfileConfig {
  if (!value || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.owner !== "string" || !value.owner.trim() || typeof value.active !== "boolean") throw new Error("Invalid shared profile configuration.");
  return { origin: sharedOrigin(value.origin), port: value.port, owner: value.owner, active: value.active };
}
export async function writeSharedConfig(config: TetherConfig, value: SharedProfileConfig): Promise<void> {
  const path = join(config.configDir, "shared-profile.json"), temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(validateSharedConfig(value)) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

/** Attaches a public application listener to the existing authoritative daemon. */
export async function startSharedProfile(daemon: TetherDaemon, config: SharedProfileConfig) {
  if (!config.active) throw new Error("Restored shared profile is fenced. Stop the previous service, then activate this authority locally.");
  const libraryId = (daemon.service.store.db.query("SELECT value FROM settings WHERE key='library_id'").get() as {value:string}).value;
  const revision = await sourceRevision();
  const attempts = new SetupAttempts(daemon.service.store.db);
  const auth = new SharedAuth({ db: daemon.service.store.db, origin: config.origin, localMachineId: daemon.service.store.localMachineId, passkeys: new FilePasskeys({ file: join(daemon.config.configDir, "owner-passkey.json"), origin: config.origin, owner: config.owner, allowOriginRecovery: true }) });
  const broker = new ConnectorBroker({ authorizeMachine: (clientId, machineId) => { const client = auth.client(clientId); return client?.kind === "connector" && client.machineId === machineId; } });
  // Migrate known identities once; credentials remain separate from file-machine metadata.
  for (const client of auth.clients()) if (client.kind === "connector" && client.machineId && !auth.machines.get(client.machineId)) {
    const name = auth.machines.list().some(machine => machine.name.toLowerCase() === client.name.toLowerCase()) ? `${client.name} (${client.machineId.slice(0, 8)})` : client.name;
    auth.machines.set(client.machineId, name);
  }
  const registerConnectors = () => {
    for (const client of auth.clients()) if (client.kind === "connector" && client.machineId && auth.client(client.id)) daemon.service.registerFileAccess(client.machineId, broker.adapter(client.machineId));
  };
  registerConnectors();
  const delivery = new ReaderDelivery(config.origin, id => auth.client(id));
  const pluginSeen = new Map<string, number>();
  const unsubscribe = auth.onRevoke(id => { pluginSeen.delete(id); broker.revokeClient(id); delivery.revoke(id); });
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../remote/shared-auth-browser.ts")], target: "browser", format: "esm", minify: true });
  if (!built.success) throw new AggregateError(built.logs, "Shared authentication build failed.");
  const renderer = await createDiagramRenderer();
  let folioVersion = 0;
  const stopFolio = daemon.library.subscribe(() => { folioVersion++; });
  const dispatch = async (operation: string, input: Record<string, unknown>, client: SharedClient) => {
    registerConnectors();
    if (operation === "plugin.connection") return { clientId: client.id, libraryId, origin: config.origin };
    if (operation === "machines.list") return { machines: auth.machines.list().map(machine => ({ ...machine, local: machine.id === daemon.service.store.localMachineId })) };
    if (operation === "plugin.folio") return { url: `${config.origin}/folio/`, sharedOrigin: config.origin, expiresAt: Date.now() + 60_000 };
    if (operation === "plugin.open") {
      if (typeof input.documentId !== "string" || !daemon.service.store.documentById(input.documentId)) throw Object.assign(new Error("Select a registered document."), { code: "invalid_document", status: 400 });
      return { origin: config.origin, documentId: input.documentId, url: `${config.origin}/reader/d/${input.documentId}/` };
    }
    if (operation === "plugin.theme") {
      await daemon.library.observeTheme?.(String(input.clientId), input.theme);
      return { updated: true };
    }
    if (operation === "plugin.poll") {
      if (client.kind !== "agent") throw Object.assign(new Error("Pair an agent client for Paseo."), { code: "invalid_client", status: 403 });
      pluginSeen.set(client.id, Date.now());
      const notices = () => delivery.read(client.id).filter(notice => notice.workspaceId && notice.host === "paseo");
      if (input.folio === folioVersion && !notices().length) await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => { clearTimeout(timer); offFolio(); offDelivery(); offRevoke(); resolve(); };
        const offFolio = daemon.library.subscribe(done), offDelivery = delivery.subscribe(done), offRevoke = auth.onRevoke(id => { if (id === client.id) done(); });
        timer = setTimeout(done, Math.min(25, Math.max(1, Number(input.timeout) || 20)) * 1000);
      });
      return { libraryId, origin: config.origin, cursor: 0, folio: folioVersion, instanceId: daemon.instanceId, intents: notices().map(notice => ({
        id: notice.id, seq: 0, kind: "document", origin: "agent", documentId: notice.documentId,
        sharedReader: { origin: config.origin, documentId: notice.documentId, url: notice.url }, target: { workspaceId: notice.workspaceId }, expiresAt: notice.expiresAt,
      })) };
    }
    if (operation === "reader.announce") {
      if (typeof input.clientId !== "string" || typeof input.documentId !== "string" || !daemon.service.store.documentById(input.documentId)) throw Object.assign(new Error("A registered document and receiving client are required."), { code: "invalid_request", status: 400 });
      if (input.host === "paseo" && !input.workspaceId) return { delivered: false, reason: "workspace_required", url: `${config.origin}/reader/d/${input.documentId}/` };
      return { delivered: true, ...delivery.enqueue(input.clientId, input.documentId, input.host as string | undefined, input.workspaceId as string | undefined) };
    }
    if (operation === "reader.receive") return { announcements: delivery.read(client.id) };
    if (operation === "reader.acknowledge") {
      if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== "string")) throw Object.assign(new Error("Announcement IDs are required."), { code: "invalid_request", status: 400 });
      delivery.acknowledge(client.id, input.ids as string[]); return { acknowledged: true };
    }
    return daemon.library.dispatch(operation, input);
  };
  const reader = { ...daemon.library.reader, open: async (id: string, options?: { resume?: boolean }) => {
    const connection = await daemon.library.reader.open(id, options);
    return { close: () => connection.close(), request: async (resource: string, request: Request) => {
      if (resource === "api/diagrams" && request.method === "POST") {
        const { sharedJson } = await import("../remote/shared-auth");
        const body = await sharedJson(request);
        let palette;
        try { palette = body.palette === undefined ? undefined : parseDiagramPalette(body.palette); }
        catch { throw Object.assign(new Error("Invalid diagram palette."), { code: "invalid_request", status: 400 }); }
        const response = await connection.request("api/file", new Request(request.url));
        if (!response.ok) return response;
        const document = await response.json();
        return Response.json({ bodyRevision: document.bodyRevision, previews: await documentDiagrams(document.body, renderer, palette, request.signal) });
      }
      const response = await connection.request(resource, request);
      if (["api/bootstrap", "api/file"].includes(resource) && response.ok) {
        const value = await response.json(), document = resource === "api/bootstrap" ? value.document : value;
        const prefs = resource === "api/bootstrap" ? value.preferences : await (await connection.request("api/preferences", new Request(request.url))).json();
        const design = prefs.customThemes?.find((theme: { id: string }) => theme.id === prefs.theme) ?? builtInDesign(prefs.theme) ?? tetherDesign(false);
        const palette = diagramPalette(design.colors, design.base.endsWith("-dark"));
        document.diagramPalette = palette; document.diagramPreviews = await documentDiagrams(document.body, renderer, palette, request.signal);
        return Response.json(value, { headers: response.headers });
      }
      return response;
    } };
  } };
  const manage = async (action: string, body: Record<string, unknown>, browserId?: string): Promise<unknown> => {
    if (action === "status") return { configured: true, sourceRevision: revision, libraryId, enabled: auth.enabled(), origin: config.origin, localPort: server.port, localMachineId: daemon.service.store.localMachineId, hubMachineId: daemon.service.store.localMachineId, viewerMachineId: browserId ? auth.client(browserId)?.machineId ?? null : daemon.service.store.localMachineId,
      passwordConfigured: auth.password.configured(), machines: auth.machines.list().map(machine => ({ ...machine, connected: machine.id === daemon.service.store.localMachineId || broker.connected(machine.id) })), clients: auth.clients(), attempts: attempts.list(), verificationDocuments: daemon.service.store.db.query("SELECT id,path,machine_id AS machineId FROM documents WHERE active=1 ORDER BY added_at DESC LIMIT 50").all() };
    if (action === "verify-attempt") {
      if (!browserId || auth.client(browserId)?.kind !== "browser") throw new Error("Verify this setup in the hub’s HTTPS Settings after signing in.");
      const attempt = attempts.get(String(body.id));
      if (attempt.answers.internet && body.internetConfirmed !== true) throw new Error("Verify browser access outside the private network first.");
      if (attempt.answers.relocate) {
        const transfer = await Bun.file(join(daemon.config.configDir, "authority-transfer.json")).json().catch(() => null);
        if (transfer?.attemptId !== attempt.id) throw new Error("Finish this attempt’s authority transfer on the destination before verifying relocation.");
      }
      const document = daemon.service.store.documentById(String(body.documentId));
      if (!document) throw new Error("Select a registered document for the live check.");
      const machineId = document.machine_id;
      if (attempt.answers.machineId && attempt.answers.machineId !== machineId) throw new Error("Select a document from this setup’s retained file machine.");
      if (machineId !== daemon.service.store.localMachineId && !broker.connected(machineId)) throw new Error("The selected file machine is offline.");
      let pluginClientId: string | undefined;
      if (attempt.answers.access !== "browser" && (body.machineId !== machineId || body.nativeConfirmed !== true)) throw new Error("Select this setup’s file machine and confirm the checks in your chosen app.");
      if (attempt.answers.access === "paseo") {
        if (body.machineId !== machineId) throw new Error("Explicitly select the file machine whose document and Paseo client you verified.");
        const client = auth.client(String(body.clientId));
        if (!client || client.kind !== "agent" || client.machineId !== machineId || (pluginSeen.get(client.id) ?? 0) < Date.now() - 60_000) throw new Error("Select a connected Paseo client explicitly associated with this file machine.");
        if (body.nativeConfirmed !== true) throw new Error("Complete the native Paseo checks before confirming setup.");
        pluginClientId = client.id;
      }
      const read = await daemon.library.dispatch("document.read", { documentId: document.id }) as { bodyRevision?: string };
      // Reports cannot call this owner-only action; native behavior is explicitly owner-confirmed.
      if (!auth.client(browserId)) throw new Error("Browser authorization ended during verification.");
      if (JSON.stringify(attempts.get(attempt.id).answers) !== JSON.stringify(attempt.answers)) throw new Error("Setup answers changed during verification. Review them and retry.");
      if (daemon.service.store.documentById(document.id)?.machine_id !== machineId || machineId !== daemon.service.store.localMachineId && !broker.connected(machineId)) throw new Error("The selected file machine changed or disconnected. Retry verification.");
      if (pluginClientId) {
        const client = auth.client(pluginClientId);
        if (!client || client.machineId !== machineId || (pluginSeen.get(client.id) ?? 0) < Date.now() - 60_000) throw new Error("The selected Paseo client changed or disconnected. Retry verification.");
      }
      return attempts.verified(attempt.id, { libraryId, origin: config.origin, machineId, documentId: document.id, bodyRevision: read.bodyRevision,
        browserClientId: browserId, pluginClientId, sourceRevision: revision, ownerConfirmedNative: body.nativeConfirmed === true, ownerConfirmedInternet: body.internetConfirmed === true });
    }
    if (action === "password") { await auth.setPassword(body.password, browserId); return { configured: true }; }
    if (action === "machine") {
      const machine = auth.machines.set(String(body.id), String(body.name), body.qualifyPaths as boolean);
      return machine;
    }
    if (action === "associate") { auth.associate(String(body.clientId), String(body.machineId)); return { associated: true }; }
    if (action === "revoke") { if (body.confirmed !== true) throw new Error("Confirm revocation."); return { revoked: auth.revoke(String(body.clientId)) }; }
    if (action === "revoke-machine") {
      const machineId = String(body.machineId);
      const affected = auth.clients().filter(client => client.machineId === machineId && client.revokedAt === null).map(client => client.id).sort();
      if (body.confirmed !== true || JSON.stringify(affected) !== JSON.stringify(Array.isArray(body.clientIds) ? [...body.clientIds].sort() : [])) throw Object.assign(new Error("The associated clients changed. Review them and confirm again."), { code: "confirmation_required", status: 409 });
      return { revoked: auth.revokeMachine(machineId) };
    }
    if (action === "enabled") {
      if (typeof body.enabled !== "boolean" || body.confirmed !== true || browserId && body.enabled) throw new Error("Enable Tether Fly through the hub’s local Settings.");
      auth.setEnabled(body.enabled); if (!body.enabled) attempts.cancelAll(); return { enabled: auth.enabled() };
    }
    if (action === "attempt") return attempts.save(body.answers, typeof body.id === "string" ? body.id : undefined);
    if (action === "approve-reporting") return attempts.approve(String(body.id), String(body.code));
    if (action === "enroll" || action === "recover") {
      if (browserId) throw new Error("Use local-owner Settings to establish or recover the owner passkey.");
      return { ...auth.beginEnrollment({ replace: action === "recover" }), verificationUrl: `${config.origin}/auth/enroll` };
    }
    throw Object.assign(new Error("Unknown Tether Fly operation."), { code: "invalid_request", status: 400 });
  };
  const gateway = new SharedGateway({ auth, reader, dispatch, setup: request => attempts.handle(request), authJavaScript: await built.outputs[0]!.text(), extension: async (request, client) => {
    if (new URL(request.url).pathname.startsWith("/folio/api/fly/")) {
      if (client.kind !== "browser" || request.method !== "POST") throw Object.assign(new Error("Owner browser verification is required."), { code: "owner_required", status: 403 });
      const { sharedJson } = await import("../remote/shared-auth");
      return Response.json(await manage(new URL(request.url).pathname.slice("/folio/api/fly/".length), await sharedJson(request), client.id));
    }
    if (new URL(request.url).pathname.startsWith("/connector/")) { registerConnectors(); return broker.handle(request, client.id); }
    if (new URL(request.url).pathname === "/folio/api/machines" && request.method === "GET") return Response.json((await dispatch("machines.list", {}, client) as {machines: unknown[]}).machines);
    return daemon.library.page(request);
  } });
  const requests = new Set<Promise<Response>>();
  let accepting = true, stopping: Promise<void> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 60, maxRequestBodySize: 46 * 1024 * 1024, fetch: request => {
    if (!accepting) return Response.json({ error: { code: "service_stopping", message: "The shared profile is stopping." } }, { status: 503, headers: { "cache-control": "no-store" } });
    const pending = gateway.handle(request);
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
    return pending;
  } });
  return {
    localControl: manage,
    stop: () => {
      if (stopping) return stopping;
      accepting = false;
      stopping = (async () => {
        unsubscribe(); stopFolio(); broker.close();
        // Closing sockets does not settle Bun's async request handlers. Keep
        // reader grants and SQLite alive until every admitted operation settles.
        await server.stop(true);
        await Promise.allSettled([...requests]);
        await gateway.close();
        await renderer.close();
      })();
      return stopping;
    },
  };
}
