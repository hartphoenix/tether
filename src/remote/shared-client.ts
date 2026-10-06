import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { SharedAccessError, sharedJson, sharedOrigin, type SharedCredential } from "./shared-auth";

function credential(value: unknown): SharedCredential {
  if (!value || typeof value !== "object") throw new SharedAccessError("invalid_credential", "The private connection credential is invalid.", 400);
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== "string" || typeof record.clientId !== "string" || !record.clientId ||
    !(record.machineId === null || typeof record.machineId === "string" && !!record.machineId) ||
    typeof record.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.token) || typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)) {
    throw new SharedAccessError("invalid_credential", "The private connection credential is invalid.", 400);
  }
  return { origin: sharedOrigin(record.origin), clientId: record.clientId, machineId: record.machineId as string | null, token: record.token, expiresAt: record.expiresAt };
}
export async function readSharedCredential(path: string): Promise<SharedCredential> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new SharedAccessError("credential_permissions", "The connection credential must be an owner-only regular file.", 400);
    try { return credential(JSON.parse(await file.readFile("utf8"))); }
    catch (cause) { if (cause instanceof SharedAccessError) throw cause; throw new SharedAccessError("invalid_credential", "The private connection credential is invalid.", 400); }
  } finally { await file.close(); }
}
export async function writeSharedCredential(path: string, value: SharedCredential): Promise<void> {
  const checked = credential(value), directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw new SharedAccessError("credential_permissions", "The connection directory must be owned by this account and not writable by others.", 400);
  const temporary = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(checked) + "\n"); await file.sync(); }
  catch (cause) { await file.close(); await unlink(temporary).catch(() => {}); throw cause; }
  await file.close();
  try { await rename(temporary, path); } catch (cause) { await unlink(temporary).catch(() => {}); throw cause; }
}

const reads = new Set(["document.read", "document.outline", "document.context", "document.diff", "document.history", "document.verify-save", "review.pending", "review.thread", "review.threads", "review.event", "review.quote-candidates", "review.operation", "folio.list", "folio.member", "folio.export", "machines.list", "reader.receive"]);
export type SharedRequestOptions = { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch };
/** HTTPS certificate checking is provided by fetch; redirects never carry a credential elsewhere. */
export async function sharedRequest<T = Record<string, unknown>>(connection: SharedCredential, operation: string, input: Record<string, unknown>, options: SharedRequestOptions = {}): Promise<T> {
  const checked = credential(connection);
  if (!/^[a-z]+(?:\.[a-z-]+)*$/.test(operation)) throw new SharedAccessError("invalid_operation", "Invalid shared operation.", 400);
  if (checked.expiresAt <= Date.now()) throw new SharedAccessError("credential_expired", "Enroll this client again; its credential has expired.", 401);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${checked.origin}/api/shared/${operation}`, {
      method: "POST", redirect: "manual", headers: { authorization: `Bearer ${checked.token}`, "content-type": "application/json" },
      body: JSON.stringify(input), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]) : AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch {
    const reading = reads.has(operation);
    throw new SharedAccessError(reading ? "service_unreachable" : operation === "document.save" ? "save_unconfirmed" : "operation_unconfirmed",
      reading ? "The shared profile service could not be reached." : "The operation response was lost; its outcome is not yet confirmed.", 503,
      { outcome: reading ? "not_applied" : "outcome_unknown" });
  }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new SharedAccessError("endpoint_changed", "The endpoint redirected. Update this client's HTTPS origin explicitly.", 409); }
  let payload: Record<string, any>;
  try { payload = await sharedJson(response, 18 * 1024 * 1024); }
  catch { throw new SharedAccessError("invalid_response", "The service response was incomplete or invalid; do not assume a mutation failed.", 502, { outcome: reads.has(operation) ? "not_applied" : "outcome_unknown" }); }
  if (!response.ok || payload.error) {
    const error = payload.error;
    throw new SharedAccessError(typeof error?.code === "string" ? error.code : "shared_request_failed", typeof error?.message === "string" ? error.message : "The shared request failed.", response.status, error?.details);
  }
  return payload as T;
}

export type PairingRequest = { requestId: string; pollSecret: string; code: string; machineId?: string | null; expiresAt: number; verificationUrl: string };
export async function beginSharedPairing(origin: string, name: string, kind: "agent" | "connector", options: { machineId?: string; fetch?: typeof fetch } | typeof fetch = {}): Promise<PairingRequest> {
  const endpoint = sharedOrigin(origin);
  const request = typeof options === "function" ? options : options.fetch ?? fetch;
  const machineId = typeof options === "function" ? undefined : options.machineId;
  const response = await request(`${endpoint}/auth/pair`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, kind, ...(machineId ? { machineId } : {}) }), signal: AbortSignal.timeout(15_000) });
  const result = await sharedJson(response);
  if (!response.ok) throw new SharedAccessError(result.error?.code ?? "pairing_failed", result.error?.message ?? "Pairing request failed.", response.status);
  if (typeof result.requestId !== "string" || typeof result.pollSecret !== "string" || typeof result.code !== "string" || typeof result.expiresAt !== "number" || typeof result.verificationUrl !== "string" || new URL(result.verificationUrl).origin !== endpoint) throw new SharedAccessError("invalid_response", "Invalid pairing response.", 502);
  return result as PairingRequest;
}
export async function pollSharedPairing(origin: string, pair: Pick<PairingRequest, "requestId" | "pollSecret">, request: typeof fetch = fetch): Promise<SharedCredential | null> {
  const endpoint = sharedOrigin(origin);
  let response: Response, result: Record<string, any>;
  try {
    response = await request(`${endpoint}/auth/pair/poll`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(pair), signal: AbortSignal.timeout(15_000) });
    result = await sharedJson(response);
  } catch {
    throw new SharedAccessError("pairing_unconfirmed", "The pairing response was lost. If completion cannot be retrieved, enroll again with the same file-machine ID and review authorized clients.", 503, { outcome: "outcome_unknown" });
  }
  if (!response.ok) throw new SharedAccessError(result.error?.code ?? "pairing_failed", result.error?.message ?? "Pairing request expired or failed.", response.status);
  if (result.status === "pending") return null;
  const connection = credential(result.credential);
  if (connection.origin !== endpoint) throw new SharedAccessError("invalid_response", "Pairing returned a different profile origin.", 502);
  return connection;
}
