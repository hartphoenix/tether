import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { bodyRevision } from "../core/index";
import { acquireFileLock } from "../documents/path-lock";
import { FileAccessError, type FileAccess, type FileAsset, type FileInspection, type FileLocation, type FileRead } from "../documents/file-access";

export const CONNECTOR_PROTOCOL = 1;
const MAX_PENDING = 64, MAX_CONNECTIONS = 64;
// A 32 MiB image expands to 44 MiB in the JSON wire representation.
const MAX_WIRE_BYTES = 46 * 1024 * 1024;
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const unavailable = () => new FileAccessError("connector_disconnected", "The file connector is disconnected.", 503);
const stale = () => new FileAccessError("stale_location", "This document location has been superseded.", 409);
const key = (location: FileLocation) => JSON.stringify([location.documentId, location.machineId, location.path, location.version]);

type Operation = "inspect" | "bind" | "read" | "save" | "image" | "resolveLink" | "barrier" | "fence";
type Command = { id: string; epoch: string; operation: Operation; args: unknown[] };
type WireError = { code: string; message: string; status: number; details?: unknown };
type WireResult = { id: string; epoch: string; value?: unknown; error?: WireError };
type Pending = { command: Command; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; dispatched: boolean };
type Connection = {
  epoch: string; machineId: string; clientId: string; instanceId: string; lastSeen: number;
  queue: Pending[]; active?: Pending;
  poll?: { resolve(command: Command | null): void; timer: ReturnType<typeof setTimeout> };
};

export type ConnectorBrokerOptions = {
  /** Must bind the requested machine to its owner-approved connector credential. */
  authorizeMachine(clientId: string, machineId: string): boolean | Promise<boolean>;
  now?: () => number;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
  connectionTimeoutMs?: number;
};

/** One bounded, non-replaying work channel for each enrolled file machine. */
export class ConnectorBroker {
  private readonly connections = new Map<string, Connection>();
  private readonly adapters = new Map<string, FileAccess>();
  private readonly now: () => number;
  private readonly requestTimeout: number;
  private readonly pollTimeout: number;
  private readonly connectionTimeout: number;
  private readonly expiry: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: ConnectorBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeout = options.requestTimeoutMs ?? 30_000;
    this.pollTimeout = options.pollTimeoutMs ?? 20_000;
    this.connectionTimeout = options.connectionTimeoutMs ?? 60_000;
    this.expiry = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (this.now() - connection.lastSeen >= this.connectionTimeout) this.end(connection);
      }
    }, Math.min(1_000, this.connectionTimeout));
    this.expiry.unref();
  }

  connected(machineId: string): boolean { return this.connections.has(machineId); }

  private end(connection: Connection): void {
    if (this.connections.get(connection.machineId) !== connection) return;
    this.connections.delete(connection.machineId);
    if (connection.poll) { clearTimeout(connection.poll.timer); connection.poll.resolve(null); connection.poll = undefined; }
    for (const pending of [...connection.queue, ...(connection.active ? [connection.active] : [])]) {
      clearTimeout(pending.timer);
      pending.reject(pending.dispatched && pending.command.operation === "save"
        ? new FileAccessError("outcome_unknown", "Save not yet confirmed.", 503, { operationId: pending.command.id, outcome: "unknown" })
        : unavailable());
    }
    connection.queue.length = 0; connection.active = undefined;
  }

  revokeClient(clientId: string): void {
    for (const connection of this.connections.values()) if (connection.clientId === clientId) this.end(connection);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.expiry);
    for (const connection of this.connections.values()) this.end(connection);
  }

  private dispatch(connection: Connection): void {
    if (!connection.poll || connection.active || !connection.queue.length) return;
    const pending = connection.queue.shift()!;
    connection.active = pending; pending.dispatched = true;
    const poll = connection.poll; connection.poll = undefined;
    clearTimeout(poll.timer); poll.resolve(pending.command);
  }

  private call(machineId: string, operation: Operation, args: unknown[], epoch?: string): Promise<unknown> {
    const connection = this.connections.get(machineId);
    if (!connection || this.closed || (epoch !== undefined && epoch !== connection.epoch)) return Promise.reject(unavailable());
    if (connection.queue.length + Number(!!connection.active) >= MAX_PENDING) return Promise.reject(new FileAccessError("connector_busy", "The file connector has too many pending operations.", 429));
    return new Promise((resolve, reject) => {
      const command: Command = { id: crypto.randomUUID(), epoch: connection.epoch, operation, args };
      const timer = setTimeout(() => this.end(connection), this.requestTimeout);
      connection.queue.push({ command, resolve, reject, timer, dispatched: false });
      this.dispatch(connection);
    });
  }

  /** A fresh incarnation rebinds locations as metadata, never replays file writes. */
  adapter(machineId: string): FileAccess {
    const existing = this.adapters.get(machineId); if (existing) return existing;
    const bindings = new Map<string, { epoch: string; ready: Promise<void> }>();
    const fenced = new Set<string>();
    const bind = async (location: FileLocation): Promise<string> => {
      if (location.machineId !== machineId || fenced.has(key(location))) throw stale();
      const connection = this.connections.get(machineId); if (!connection) throw unavailable();
      const identity = key(location), previous = bindings.get(identity);
      if (previous?.epoch === connection.epoch) { await previous.ready; return previous.epoch; }
      const ready = this.call(machineId, "bind", [location], connection.epoch).then(() => {});
      const binding = { epoch: connection.epoch, ready }; bindings.set(identity, binding);
      try { await ready; return binding.epoch; }
      catch (error) { if (bindings.get(identity) === binding) bindings.delete(identity); throw error; }
    };
    const bound = async (operation: Operation, location: FileLocation, ...args: unknown[]) => {
      const epoch = await bind(location);
      if (fenced.has(key(location))) throw stale();
      return this.call(machineId, operation, [location, ...args], epoch);
    };
    const adapter: FileAccess = {
      inspect: async path => inspection(await this.call(machineId, "inspect", [path])),
      bind: async location => { await bind(location); },
      read: async location => fileRead(await bound("read", location)),
      save: async (location, input) => {
        const result = await bound("save", location, input);
        try { return fileRead(result); }
        catch { throw new FileAccessError("outcome_unknown", "Save not yet confirmed.", 503, { outcome: "unknown" }); }
      },
      image: async (location, source) => asset(await bound("image", location, source)),
      resolveLink: async (location, target, format) => inspection(await bound("resolveLink", location, target, format)),
      barrier: async location => { await bound("barrier", location); },
      fence: async location => {
        if (location.machineId !== machineId) throw stale();
        const identity = key(location);
        // Fence admission synchronously, including operations waiting for bind.
        fenced.add(identity);
        const connection = this.connections.get(machineId); if (!connection) throw unavailable();
        await this.call(machineId, "fence", [location], connection.epoch);
        bindings.delete(identity);
      },
    };
    this.adapters.set(machineId, adapter); return adapter;
  }

  /** Gateway authenticates every request before calling this method. */
  async handle(request: Request, clientId: string): Promise<Response> {
    try {
      if (this.closed) throw unavailable();
      const route = new URL(request.url).pathname;
      if (request.method !== "POST" || !/^\/connector\/(connect|poll|result|disconnect)$/.test(route)) return Response.json({ error: { code: "not_found", message: "Unknown connector operation." } }, { status: 404 });
      const body = object(await boundedJson(request, route.endsWith("/result") ? MAX_WIRE_BYTES : 16_384));
      const machineId = string(body.machineId, 200);
      if (!await this.options.authorizeMachine(clientId, machineId)) return Response.json({ error: { code: "access_denied", message: "Connector access denied." } }, { status: 403 });
      if (this.closed) throw unavailable();
      if (route.endsWith("/connect")) {
        if (body.protocol !== CONNECTOR_PROTOCOL) throw new FileAccessError("connector_protocol_mismatch", "Update the file connector to match this service.", 426);
        if (body.drained !== true) throw new FileAccessError("connector_not_drained", "The previous connector operations must finish before reconnecting.", 409);
        const instanceId = string(body.instanceId, 200);
        const previous = this.connections.get(machineId); if (previous) this.end(previous);
        if (this.connections.size >= MAX_CONNECTIONS) throw new FileAccessError("connector_limit", "Too many file connectors.", 429);
        const epoch = crypto.randomUUID();
        this.connections.set(machineId, { epoch, machineId, clientId, instanceId, lastSeen: this.now(), queue: [] });
        return Response.json({ protocol: CONNECTOR_PROTOCOL, epoch });
      }
      const connection = this.connections.get(machineId);
      if (!connection || connection.clientId !== clientId || body.epoch !== connection.epoch) throw unavailable();
      connection.lastSeen = this.now();
      if (route.endsWith("/disconnect")) { this.end(connection); return Response.json({ disconnected: true }); }
      if (route.endsWith("/result")) {
        const pending = connection.active;
        if (!pending || body.id !== pending.command.id) throw new FileAccessError("connector_operation_stale", "This connector operation is no longer pending.", 409);
        let failure: FileAccessError | undefined;
        if (body.error !== undefined) {
          const error = object(body.error);
          failure = new FileAccessError(string(error.code, 200), string(error.message, 2_000), status(error.status), error.details);
        }
        connection.active = undefined; clearTimeout(pending.timer);
        if (failure) pending.reject(failure); else pending.resolve(body.value);
        return Response.json({ accepted: true });
      }
      if (connection.poll || connection.active) throw new FileAccessError("connector_operation_pending", "Finish the accepted operation before polling again.", 409);
      const command = await new Promise<Command | null>(resolve => {
        const timer = setTimeout(() => { if (connection.poll?.resolve === resolve) connection.poll = undefined; resolve(null); }, this.pollTimeout);
        connection.poll = { resolve, timer }; this.dispatch(connection);
      });
      if (this.connections.get(machineId) !== connection || !await this.options.authorizeMachine(clientId, machineId)) { this.end(connection); throw unavailable(); }
      return Response.json({ command });
    } catch (error) { return errorResponse(error); }
  }
}

export type FileConnectorOptions = {
  endpoint: string; token: string; machineId: string; files: FileAccess;
  /** Stable private file on this machine; must remain the same across restarts. */
  lockPath: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  allowLoopbackHttp?: boolean;
  retryMinMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "revoked") => void;
};

/** Outbound-only connector. Closing a socket never cancels an accepted disk operation. */
export async function runFileConnector(options: FileConnectorOptions): Promise<void> {
  const endpoint = connectorOrigin(options.endpoint, options.allowLoopbackHttp === true);
  const lockDirectory = dirname(options.lockPath);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(lockDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) throw new Error("Unsafe file-connector lock directory.");
  const lock = await acquireFileLock(options.lockPath);
  const instanceId = crypto.randomUUID();
  const send = async (route: string, body: unknown, signal = options.signal) => {
    const response = await (options.fetch ?? fetch)(new URL(`/connector/${route}`, endpoint), {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)]),
    });
    const value = object(await boundedJson(response, MAX_WIRE_BYTES));
    if (!response.ok) { const detail = object(value.error); throw new FileAccessError(string(detail.code, 200), string(detail.message, 2_000), response.status, detail.details); }
    return value;
  };
  let delay = options.retryMinMs ?? 250;
  try {
    while (!options.signal.aborted) {
      let epoch: string | undefined;
      try {
        options.onStatus?.("connecting");
        // The loop is sequential: every accepted operation from the previous
        // epoch has settled before this assertion can be sent, even after abort.
        const hello = await send("connect", { protocol: CONNECTOR_PROTOCOL, machineId: options.machineId, instanceId, drained: true });
        if (hello.protocol !== CONNECTOR_PROTOCOL) throw new FileAccessError("connector_protocol_mismatch", "Update the file connector to match this service.", 426);
        epoch = string(hello.epoch, 200); options.onStatus?.("connected");
        while (!options.signal.aborted) {
          const polled = await send("poll", { machineId: options.machineId, epoch });
          delay = options.retryMinMs ?? 250;
          if (polled.command === null) continue;
          const command = parseCommand(polled.command, epoch);
          // No AbortSignal enters disk work. We await completion before release,
          // reconnect, or a replacement process can acquire the instance lock.
          const result = await perform(options.files, command);
          await send("result", { machineId: options.machineId, ...result });
        }
      } catch (error) {
        if (options.signal.aborted) break;
        if (error instanceof FileAccessError && [401, 403, 426].includes(error.status)) { options.onStatus?.("revoked"); throw error; }
        options.onStatus?.("disconnected");
      } finally {
        if (epoch) await send("disconnect", { machineId: options.machineId, epoch }, AbortSignal.timeout(2_000)).catch(() => {});
      }
      if (!options.signal.aborted) await pause(delay, options.signal);
      delay = Math.min(delay * 2, options.retryMaxMs ?? 10_000);
    }
  } finally { await lock.release(); }
}

async function perform(files: FileAccess, command: Command): Promise<WireResult> {
  try {
    const args = command.args; let value: unknown;
    if (command.operation === "inspect") value = await files.inspect(string(args[0], 32_768));
    else {
      const location = parseLocation(args[0]);
      if (command.operation === "bind") value = await files.bind(location);
      else if (command.operation === "read") value = await files.read(location);
      else if (command.operation === "save") {
        const input = object(args[1]); value = await files.save(location, { body: string(input.body, MAX_REQUEST_BYTES), expectedBodyRevision: string(input.expectedBodyRevision, 200) });
      } else if (command.operation === "image") {
        const image = await files.image(location, string(args[1], 32_768));
        if (image.bytes.byteLength > 32 * 1024 * 1024) throw new FileAccessError("image_too_large", "Image exceeds 32 MiB.", 413);
        value = { ...image, bytes: Buffer.from(image.bytes).toString("base64") };
      } else if (command.operation === "resolveLink") {
        if (args[2] !== "wikilink" && args[2] !== "markdown") throw new FileAccessError("invalid_request", "Invalid link format.", 400);
        value = await files.resolveLink(location, string(args[1], 32_768), args[2]);
      } else if (command.operation === "barrier") value = await files.barrier(location);
      else value = await files.fence(location);
    }
    return { id: command.id, epoch: command.epoch, value };
  } catch (error) {
    return { id: command.id, epoch: command.epoch, error: error instanceof FileAccessError
      ? { code: error.code, message: error.message, status: error.status, details: error.details }
      : { code: "file_access_failed", message: "The file machine could not complete this operation.", status: 500 } };
  }
}

function parseCommand(value: unknown, epoch: string): Command {
  const command = object(value);
  if (command.epoch !== epoch || !["inspect", "bind", "read", "save", "image", "resolveLink", "barrier", "fence"].includes(String(command.operation)) || !Array.isArray(command.args) || command.args.length > 4) throw new FileAccessError("invalid_connector_command", "Invalid connector command.", 400);
  return { id: string(command.id, 200), epoch, operation: command.operation as Operation, args: command.args };
}
function parseLocation(value: unknown): FileLocation {
  const input = object(value);
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) throw new FileAccessError("invalid_request", "Invalid location version.", 400);
  return { documentId: string(input.documentId, 200), machineId: string(input.machineId, 200), path: string(input.path, 32_768), version: Number(input.version) };
}
function inspection(value: unknown): FileInspection {
  const item = object(value);
  if (typeof item.mtimeMs !== "number" || !Number.isFinite(item.mtimeMs) || (item.createdAtMs !== null && (typeof item.createdAtMs !== "number" || !Number.isFinite(item.createdAtMs)))) throw new FileAccessError("invalid_connector_result", "Invalid file metadata.", 502);
  return { path: string(item.path, 32_768), mtimeMs: item.mtimeMs, createdAtMs: item.createdAtMs as number | null, ...(typeof item.title === "string" ? { title: item.title } : {}) };
}
function fileRead(value: unknown): FileRead {
  const item = object(value), revision = string(item.bodyRevision, 200);
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) throw new FileAccessError("invalid_connector_result", "Invalid body revision.", 502);
  const source = string(item.source, MAX_REQUEST_BYTES);
  if (bodyRevision(source) !== revision) throw new FileAccessError("invalid_connector_result", "The file bytes and revision do not match.", 502);
  return { source, bodyRevision: revision as FileRead["bodyRevision"] };
}
function asset(value: unknown): FileAsset {
  const item = object(value), encoded = string(item.bytes, MAX_WIRE_BYTES);
  const padding = encoded.indexOf("=");
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || (padding !== -1 && (padding < encoded.length - 2 || !/^={1,2}$/.test(encoded.slice(padding))))) throw new FileAccessError("invalid_connector_result", "Invalid image bytes.", 502);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > 32 * 1024 * 1024) throw new FileAccessError("image_too_large", "Image exceeds 32 MiB.", 413);
  const contentType = string(item.contentType, 200), etag = string(item.etag, 200);
  if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"].includes(contentType) || !/^"[a-f0-9]{64}"$/.test(etag)) throw new FileAccessError("invalid_connector_result", "Invalid image metadata.", 502);
  return { bytes, contentType, etag };
}
function connectorOrigin(value: string, allowLoopbackHttp: boolean): URL {
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password || (origin.protocol !== "https:" && !(allowLoopbackHttp && origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) throw new Error("The connector requires an exact HTTPS origin.");
  return origin;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FileAccessError("invalid_request", "A JSON object is required.", 400);
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new FileAccessError("invalid_request", "Invalid text value.", 400);
  return value;
}
function status(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500; }
function errorResponse(error: unknown): Response {
  const detail = error instanceof FileAccessError ? error : new FileAccessError("invalid_request", "Invalid connector request.", 400);
  return Response.json({ error: { code: detail.code, message: detail.message, details: detail.details } }, { status: detail.status, headers: { "cache-control": "no-store" } });
}
async function boundedJson(input: Request | Response, limit: number): Promise<unknown> {
  if (!input.headers.get("content-type")?.startsWith("application/json")) throw new FileAccessError("invalid_request", "JSON content is required.", 400);
  const reader = input.body?.getReader(); if (!reader) throw new FileAccessError("invalid_request", "A request body is required.", 400);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new FileAccessError("request_too_large", "Connector message exceeds its size limit.", 413); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true });
  });
}
