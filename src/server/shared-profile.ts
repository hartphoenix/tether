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
  const auth = new SharedAuth({ db: daemon.service.store.db, origin: config.origin, localMachineId: daemon.service.store.localMachineId, passkeys: new FilePasskeys({ file: join(daemon.config.configDir, "owner-passkey.json"), origin: config.origin, owner: config.owner, allowOriginRecovery: true }) });
  const broker = new ConnectorBroker({ authorizeMachine: (clientId, machineId) => { const client = auth.client(clientId); return client?.kind === "connector" && client.machineId === machineId; } });
  const registerConnectors = () => {
    for (const client of auth.clients()) if (client.kind === "connector" && client.machineId && auth.client(client.id)) daemon.service.registerFileAccess(client.machineId, broker.adapter(client.machineId));
  };
  registerConnectors();
  const delivery = new ReaderDelivery(config.origin, id => auth.client(id));
  const unsubscribe = auth.onRevoke(id => { broker.revokeClient(id); delivery.revoke(id); });
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../remote/shared-auth-browser.ts")], target: "browser", format: "esm", minify: true });
  if (!built.success) throw new AggregateError(built.logs, "Shared authentication build failed.");
  const renderer = await createDiagramRenderer();
  const dispatch = async (operation: string, input: Record<string, unknown>, client: SharedClient) => {
    registerConnectors();
    if (operation === "machines.list") return [{ id: daemon.service.store.localMachineId, name: hostname(), local: true }, ...auth.clients().filter(item => item.kind === "connector" && auth.client(item.id)).map(item => ({ id: item.machineId, name: item.name, local: false }))];
    if (operation === "reader.announce") {
      if (typeof input.clientId !== "string" || typeof input.documentId !== "string" || !daemon.service.store.documentById(input.documentId)) throw Object.assign(new Error("A registered document and receiving client are required."), { code: "invalid_request", status: 400 });
      return delivery.enqueue(input.clientId, input.documentId, input.host as string | undefined);
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
  const gateway = new SharedGateway({ auth, reader, dispatch, authJavaScript: await built.outputs[0]!.text(), extension: async (request, client) => {
    if (new URL(request.url).pathname.startsWith("/connector/")) { registerConnectors(); return broker.handle(request, client.id); }
    if (new URL(request.url).pathname === "/folio/api/machines" && request.method === "GET") return Response.json(await dispatch("machines.list", {}, client));
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
    localControl: async (action: string, body: Record<string, unknown>) => {
      if (action === "enroll" || action === "recover") return { ...auth.beginEnrollment({ replace: action === "recover" }), verificationUrl: `${config.origin}/auth/enroll` };
      if (action === "status") return { origin: config.origin, localPort: server.port, localMachineId: daemon.service.store.localMachineId };
      throw Object.assign(new Error("Unknown local shared-profile operation."), { code: "invalid_request", status: 400 });
    },
    stop: () => {
      if (stopping) return stopping;
      accepting = false;
      stopping = (async () => {
        unsubscribe(); broker.close();
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
