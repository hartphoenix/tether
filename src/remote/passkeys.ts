import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

/**
 * One owner's passkey. Challenge issuance, single use, expiry, and the enrollment window belong to
 * the caller; a resolved `register` or `authenticate` only proves the response verified.
 */
export interface PasskeyProvider {
  enrolled(): boolean;
  registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON>;
  register(challenge: string, response: RegistrationResponseJSON): Promise<void>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  authenticate(challenge: string, response: AuthenticationResponseJSON): Promise<void>;
}

export type FilePasskeysOptions = {
  file: string;
  /** Exact origin, e.g. `https://tether.example.net`. The RP ID is its hostname. */
  origin: string;
  owner: string;
  /** Development only: also accept `http://localhost[:port]`. */
  allowLoopbackHttp?: boolean;
};

export type PasskeyErrorCode = "invalid-config" | "invalid-store" | "identity-mismatch" | "not-enrolled" | "already-enrolled" | "verification-failed";

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PasskeyError";
    this.code = code;
  }
}

type StoredCredential = { id: string; publicKey: string; counter: number; transports?: string[] };
type PasskeyRecord = { version: 1; origin: string; rpID: string; owner: string; createdAt: string; credential: StoredCredential };

const RECORD_KEYS = ["version", "origin", "rpID", "owner", "createdAt", "credential"];
const CREDENTIAL_KEYS = ["id", "publicKey", "counter", "transports"];
const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const TIMEOUT_MS = 120_000;

export class FilePasskeys implements PasskeyProvider {
  readonly origin: string;
  readonly rpID: string;
  readonly owner: string;
  private readonly file: string;
  private record: PasskeyRecord | null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FilePasskeysOptions) {
    const { origin, rpID } = parseOrigin(options.origin, options.allowLoopbackHttp === true);
    this.origin = origin;
    this.rpID = rpID;
    this.owner = parseOwner(options.owner);
    if (typeof options.file !== "string" || options.file.length === 0) throw new PasskeyError("invalid-config", "Passkey file path is required.");
    this.file = options.file;
    prepareDirectory(dirname(this.file));
    this.record = this.load();
  }

  enrolled(): boolean {
    return this.record !== null;
  }

  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (this.record) throw new PasskeyError("already-enrolled", "A passkey is already enrolled.");
    return generateRegistrationOptions({
      rpName: "Tether",
      rpID: this.rpID,
      userName: this.owner,
      userDisplayName: this.owner,
      // Stable per owner and origin so re-enrolling replaces the authenticator's stale entry.
      userID: new Uint8Array(createHash("sha256").update(`tether-passkey\0${this.origin}\0${this.owner}`).digest()),
      timeout: TIMEOUT_MS,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
  }

  register(challenge: string, response: RegistrationResponseJSON): Promise<void> {
    return this.serialized(async () => {
      if (this.record) throw new PasskeyError("already-enrolled", "A passkey is already enrolled.");
      const result = await verified(() => verifyRegistrationResponse({
        response,
        expectedChallenge: requireChallenge(challenge),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
      }));
      if (!result.verified || !result.registrationInfo.userVerified) throw new PasskeyError("verification-failed", "Passkey registration did not verify.");
      const { credential } = result.registrationInfo;
      const transports = response.response.transports?.filter((transport) => TRANSPORTS.has(transport));
      const record: PasskeyRecord = {
        version: 1,
        origin: this.origin,
        rpID: this.rpID,
        owner: this.owner,
        createdAt: new Date().toISOString(),
        credential: {
          id: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          ...(transports?.length ? { transports } : {}),
        },
      };
      await this.writeExclusive(record);
      this.record = record;
    });
  }

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const record = this.requireRecord();
    return generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [{ id: record.credential.id, transports: record.credential.transports }],
      userVerification: "required",
      timeout: TIMEOUT_MS,
    });
  }

  authenticate(challenge: string, response: AuthenticationResponseJSON): Promise<void> {
    return this.serialized(async () => {
      const record = this.requireRecord();
      if (response?.id !== record.credential.id) throw new PasskeyError("verification-failed", "Passkey response used an unknown credential.");
      const result = await verified(() => verifyAuthenticationResponse({
        response,
        expectedChallenge: requireChallenge(challenge),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: toCredential(record.credential),
        requireUserVerification: true,
      }));
      if (!result.verified || !result.authenticationInfo.userVerified) throw new PasskeyError("verification-failed", "Passkey authentication did not verify.");
      const { newCounter } = result.authenticationInfo;
      if (newCounter === record.credential.counter) return;
      const next: PasskeyRecord = { ...record, credential: { ...record.credential, counter: newCounter } };
      await this.writeReplace(next);
      this.record = next;
    });
  }

  private requireRecord(): PasskeyRecord {
    if (!this.record) throw new PasskeyError("not-enrolled", "No passkey is enrolled.");
    return this.record;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private load(): PasskeyRecord | null {
    let descriptor: number;
    try {
      descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PasskeyError("invalid-store", "Passkey file must not be a symbolic link.");
      throw error;
    }
    let text: string;
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) throw new PasskeyError("invalid-store", "Passkey file is not a regular file.");
      if (stats.uid !== process.getuid?.()) throw new PasskeyError("invalid-store", "Passkey file is not owned by this user.");
      if ((stats.mode & 0o077) !== 0) throw new PasskeyError("invalid-store", "Passkey file must not be accessible to other users (expected 0600).");
      text = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
    const record = parseRecord(text);
    if (record.origin !== this.origin || record.rpID !== this.rpID || record.owner !== this.owner) {
      throw new PasskeyError("identity-mismatch", "Passkey file belongs to a different origin or owner.");
    }
    return record;
  }

  /** Publishes a fully written file only if none exists, so a concurrent enrollment cannot be replaced. */
  private async writeExclusive(record: PasskeyRecord): Promise<void> {
    const temporary = await this.writeTemporary(record);
    try {
      await link(temporary, this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PasskeyError("already-enrolled", "A passkey is already enrolled.");
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async writeReplace(record: PasskeyRecord): Promise<void> {
    const temporary = await this.writeTemporary(record);
    try {
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async writeTemporary(record: PasskeyRecord): Promise<string> {
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2) + "\n");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await handle.close();
    return temporary;
  }
}

function parseOrigin(value: string, allowLoopbackHttp: boolean): { origin: string; rpID: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PasskeyError("invalid-config", "Passkey origin must be an absolute URL origin.");
  }
  if (url.origin !== value) throw new PasskeyError("invalid-config", `Passkey origin must be exact, e.g. ${url.origin}.`);
  const loopback = allowLoopbackHttp && url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !loopback) throw new PasskeyError("invalid-config", "Passkey origin must use HTTPS.");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) throw new PasskeyError("invalid-config", "Passkey origin must use a domain name, not an IP address.");
  return { origin: url.origin, rpID: url.hostname };
}

function parseOwner(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new PasskeyError("invalid-config", "Passkey owner must be 1–64 printable characters without surrounding spaces.");
  }
  return value;
}

function requireChallenge(challenge: string): string {
  if (typeof challenge !== "string" || challenge.length === 0) throw new PasskeyError("verification-failed", "A passkey challenge is required.");
  return challenge;
}

async function verified<T>(verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    throw new PasskeyError("verification-failed", "Passkey response did not verify.", { cause: error });
  }
}

function toCredential(stored: StoredCredential): WebAuthnCredential {
  return { id: stored.id, publicKey: isoBase64URL.toBuffer(stored.publicKey), counter: stored.counter, transports: stored.transports };
}

function parseRecord(text: string): PasskeyRecord {
  const invalid = () => new PasskeyError("invalid-store", "Passkey file is malformed.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isPlainObject(value) || !hasOnlyKeys(value, RECORD_KEYS)) throw invalid();
  const { version, origin, rpID, owner, createdAt, credential } = value;
  if (version !== 1 || typeof origin !== "string" || typeof rpID !== "string" || typeof owner !== "string" || typeof createdAt !== "string") throw invalid();
  if (!isPlainObject(credential) || !hasOnlyKeys(credential, CREDENTIAL_KEYS)) throw invalid();
  const { id, publicKey, counter, transports } = credential;
  if (!isBase64URL(id) || !isBase64URL(publicKey)) throw invalid();
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0 || counter > 0xffffffff) throw invalid();
  if (transports !== undefined && (!Array.isArray(transports) || !transports.every((transport) => typeof transport === "string" && TRANSPORTS.has(transport)))) throw invalid();
  return {
    version, origin, rpID, owner, createdAt,
    credential: { id, publicKey, counter, ...(transports ? { transports } : {}) },
  };
}

function prepareDirectory(directory: string): void {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created) chmodSync(directory, 0o700);
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) throw new PasskeyError("invalid-store", "Passkey directory is not a directory.");
  if (stats.uid !== process.getuid?.()) throw new PasskeyError("invalid-store", "Passkey directory is not owned by this user.");
  if ((stats.mode & 0o022) !== 0) throw new PasskeyError("invalid-store", "Passkey directory must not be writable by other users.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBase64URL(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isoBase64URL.isBase64URL(value);
}
