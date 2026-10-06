import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { FilePasskeys, PasskeyError, type PasskeyErrorCode } from "../src/remote/passkeys";

const ORIGIN = "https://tether.example.net";
const RP_ID = "tether.example.net";
const OWNER = "hart";
type CBORValue = Parameters<typeof isoCBOR.encode>[0];
const UP = 0x01, UV = 0x04, AT = 0x40;

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join("/tmp", "tether-passkeys-")); directories.push(directory); return directory;
}

/** Software ES256 authenticator: test-only signing, verification stays in SimpleWebAuthn. */
class FakeAuthenticator {
  readonly id = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
  private readonly privateKey: KeyObject;
  private readonly cose: Uint8Array;
  counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKey = privateKey;
    this.cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x!)], [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]));
  }

  register(challenge: string, { origin = ORIGIN, rpID = RP_ID, flags = UP | UV | AT } = {}): RegistrationResponseJSON {
    const credentialId = isoBase64URL.toBuffer(this.id);
    const authData = concat(rpHash(rpID), [flags], u32(this.counter), new Uint8Array(16), [credentialId.length >> 8, credentialId.length & 0xff], credentialId, this.cose);
    const attestationObject = isoCBOR.encode(new Map<string, CBORValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: clientData("webauthn.create", challenge, origin), attestationObject: isoBase64URL.fromBuffer(attestationObject), transports: ["internal", "hybrid"] },
    };
  }

  assert(challenge: string, { origin = ORIGIN, rpID = RP_ID, flags = UP | UV, counter = this.counter } = {}): AuthenticationResponseJSON {
    const clientDataJSON = clientData("webauthn.get", challenge, origin);
    const authenticatorData = concat(rpHash(rpID), [flags], u32(counter));
    const signed = concat(authenticatorData, createHash("sha256").update(isoBase64URL.toBuffer(clientDataJSON)).digest());
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON, authenticatorData: isoBase64URL.fromBuffer(authenticatorData), signature: isoBase64URL.fromBuffer(new Uint8Array(sign("sha256", signed, this.privateKey))) },
    };
  }
}

function clientData(type: string, challenge: string, origin: string): string {
  return isoBase64URL.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}
function rpHash(rpID: string): Uint8Array { return new Uint8Array(createHash("sha256").update(rpID).digest()); }
function u32(value: number): number[] { return [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff]; }
function concat(...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function rejectsWith(promise: Promise<unknown>, code: PasskeyErrorCode): Promise<void> {
  const error = await promise.then(() => null, (cause) => cause);
  expect(error).toBeInstanceOf(PasskeyError); expect((error as PasskeyError).code).toBe(code);
}
function throwsWith(run: () => unknown, code: PasskeyErrorCode): void {
  let error: unknown = null; try { run(); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(PasskeyError); expect((error as PasskeyError).code).toBe(code);
}

async function enrolled(file: string, authenticator = new FakeAuthenticator()) {
  const passkeys = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
  const { challenge } = await passkeys.registrationOptions();
  await passkeys.register(challenge, authenticator.register(challenge));
  return { passkeys, authenticator };
}

describe("FilePasskeys configuration", () => {
  test("accepts only an exact HTTPS domain origin, with loopback HTTP behind an explicit flag", async () => {
    const file = join(await scratch(), "passkey.json");
    for (const origin of ["http://tether.example.net", "https://tether.example.net/", "https://tether.example.net/app", "https://127.0.0.1", "https://[::1]", "not a url", "http://localhost:4000"]) {
      throwsWith(() => new FilePasskeys({ file, origin, owner: OWNER }), "invalid-config");
    }
    throwsWith(() => new FilePasskeys({ file, origin: "http://127.0.0.1:4000", owner: OWNER, allowLoopbackHttp: true }), "invalid-config");
    const local = new FilePasskeys({ file, origin: "http://localhost:4000", owner: OWNER, allowLoopbackHttp: true });
    expect(local.rpID).toBe("localhost");
    expect(new FilePasskeys({ file, origin: "https://tether.example.net:8443", owner: OWNER }).rpID).toBe(RP_ID);
    throwsWith(() => new FilePasskeys({ file, origin: ORIGIN, owner: "" }), "invalid-config");
    throwsWith(() => new FilePasskeys({ file, origin: ORIGIN, owner: "a\nb" }), "invalid-config");
  });

  test("creates a private parent directory without creating the credential file", async () => {
    const file = join(await scratch(), "remote", "passkey.json");
    const passkeys = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    expect(passkeys.enrolled()).toBe(false);
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);
    expect(await stat(file).catch(() => null)).toBeNull();
  });

  test("requests required user verification, preferred resident key, and no attestation", async () => {
    const passkeys = new FilePasskeys({ file: join(await scratch(), "passkey.json"), origin: ORIGIN, owner: OWNER });
    const options = await passkeys.registrationOptions();
    expect(options.rp.id).toBe(RP_ID);
    expect(options.user.name).toBe(OWNER);
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "preferred", userVerification: "required" });
    await rejectsWith(passkeys.authenticationOptions(), "not-enrolled");
  });
});

describe("FilePasskeys registration and authentication", () => {
  test("registers once, persists only public credential data, and authenticates after reload", async () => {
    const directory = await scratch(); const file = join(directory, "passkey.json");
    const { passkeys, authenticator } = await enrolled(file);
    expect(passkeys.enrolled()).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(stored).sort()).toEqual(["createdAt", "credential", "origin", "owner", "rpID", "version"]);
    expect(Object.keys(stored.credential).sort()).toEqual(["counter", "id", "publicKey", "transports"]);
    expect(stored).toMatchObject({ origin: ORIGIN, rpID: RP_ID, owner: OWNER, credential: { id: authenticator.id, counter: 0, transports: ["internal", "hybrid"] } });
    expect(JSON.stringify(stored)).not.toContain('"d"');

    await rejectsWith(passkeys.registrationOptions(), "already-enrolled");
    await rejectsWith(passkeys.register("again", new FakeAuthenticator().register("again")), "already-enrolled");

    const reloaded = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    expect(reloaded.enrolled()).toBe(true);
    const options = await reloaded.authenticationOptions();
    expect(options).toMatchObject({ rpId: RP_ID, userVerification: "required", allowCredentials: [{ id: authenticator.id, type: "public-key" }] });
    await reloaded.authenticate(options.challenge, authenticator.assert(options.challenge));
  });

  test("rejects registration with wrong origin, RP ID, challenge, or missing user verification", async () => {
    const file = join(await scratch(), "passkey.json");
    const passkeys = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    const { challenge } = await passkeys.registrationOptions();
    const authenticator = new FakeAuthenticator();
    await rejectsWith(passkeys.register(challenge, authenticator.register(challenge, { origin: "https://evil.example.net" })), "verification-failed");
    await rejectsWith(passkeys.register(challenge, authenticator.register(challenge, { rpID: "evil.example.net" })), "verification-failed");
    await rejectsWith(passkeys.register(challenge, authenticator.register("other-challenge")), "verification-failed");
    await rejectsWith(passkeys.register(challenge, authenticator.register(challenge, { flags: UP | AT })), "verification-failed");
    await rejectsWith(passkeys.register("", authenticator.register("")), "verification-failed");
    expect(passkeys.enrolled()).toBe(false);
    expect(await stat(file).catch(() => null)).toBeNull();
    await passkeys.register(challenge, authenticator.register(challenge));
    expect(passkeys.enrolled()).toBe(true);
  });

  test("rejects authentication with wrong origin, RP ID, challenge, credential, signature, or missing user verification", async () => {
    const { passkeys, authenticator } = await enrolled(join(await scratch(), "passkey.json"));
    const { challenge } = await passkeys.authenticationOptions();
    await rejectsWith(passkeys.authenticate(challenge, authenticator.assert(challenge, { origin: "https://evil.example.net" })), "verification-failed");
    await rejectsWith(passkeys.authenticate(challenge, authenticator.assert(challenge, { rpID: "evil.example.net" })), "verification-failed");
    await rejectsWith(passkeys.authenticate(challenge, authenticator.assert("other-challenge")), "verification-failed");
    await rejectsWith(passkeys.authenticate(challenge, authenticator.assert(challenge, { flags: UP })), "verification-failed");
    const stranger = new FakeAuthenticator();
    await rejectsWith(passkeys.authenticate(challenge, stranger.assert(challenge)), "verification-failed");
    const forged = { ...stranger.assert(challenge), id: authenticator.id, rawId: authenticator.id };
    await rejectsWith(passkeys.authenticate(challenge, forged), "verification-failed");
    await passkeys.authenticate(challenge, authenticator.assert(challenge));
  });

  test("persists the authenticator counter and rejects regressions, including concurrent replays", async () => {
    const file = join(await scratch(), "passkey.json");
    const { passkeys, authenticator } = await enrolled(file);
    await passkeys.authenticate("c1", authenticator.assert("c1", { counter: 5 }));
    expect(JSON.parse(await readFile(file, "utf8")).credential.counter).toBe(5);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rejectsWith(passkeys.authenticate("c2", authenticator.assert("c2", { counter: 5 })), "verification-failed");

    const results = await Promise.allSettled([
      passkeys.authenticate("c3", authenticator.assert("c3", { counter: 6 })),
      passkeys.authenticate("c4", authenticator.assert("c4", { counter: 6 })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const reloaded = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    await rejectsWith(reloaded.authenticate("c5", authenticator.assert("c5", { counter: 6 })), "verification-failed");
    await reloaded.authenticate("c6", authenticator.assert("c6", { counter: 7 }));
  });

  test("accepts authenticators that always report a zero counter", async () => {
    const { passkeys, authenticator } = await enrolled(join(await scratch(), "passkey.json"));
    await passkeys.authenticate("a", authenticator.assert("a"));
    await passkeys.authenticate("b", authenticator.assert("b"));
  });

  test("concurrent and cross-instance enrollment cannot replace the first owner credential", async () => {
    const file = join(await scratch(), "passkey.json");
    const first = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    const second = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    const [a, b, c] = [new FakeAuthenticator(), new FakeAuthenticator(), new FakeAuthenticator()];
    const results = await Promise.allSettled([first.register("x", a.register("x")), first.register("y", b.register("y"))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = results[0].status === "fulfilled" ? a : b;
    await rejectsWith(second.register("z", c.register("z")), "already-enrolled");
    expect(JSON.parse(await readFile(file, "utf8")).credential.id).toBe(winner.id);
  });
});

describe("FilePasskeys stored file", () => {
  test("refuses a file pinned to a different owner or origin", async () => {
    const file = join(await scratch(), "passkey.json");
    await enrolled(file);
    throwsWith(() => new FilePasskeys({ file, origin: ORIGIN, owner: "someone-else" }), "identity-mismatch");
    throwsWith(() => new FilePasskeys({ file, origin: "https://other.example.net", owner: OWNER }), "identity-mismatch");
    throwsWith(() => new FilePasskeys({ file, origin: "https://tether.example.net:8443", owner: OWNER }), "identity-mismatch");
  });

  test("refuses malformed, extended, permissive, and symlinked credential files", async () => {
    const directory = await scratch(); const file = join(directory, "passkey.json");
    await enrolled(file);
    const valid = JSON.parse(await readFile(file, "utf8"));
    const write = async (value: unknown) => { await rm(file, { force: true }); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); };
    const open = () => new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });

    for (const value of [
      "{", "null", [], { ...valid, version: 2 }, { ...valid, privateKey: "x" },
      { ...valid, credential: { ...valid.credential, d: "x" } },
      { ...valid, credential: { ...valid.credential, counter: -1 } },
      { ...valid, credential: { ...valid.credential, publicKey: "not base64url!" } },
      { ...valid, credential: { ...valid.credential, transports: ["carrier-pigeon"] } },
    ]) { await write(value); throwsWith(open, "invalid-store"); }

    await write(valid); await chmod(file, 0o644); throwsWith(open, "invalid-store");
    await chmod(file, 0o600); expect(open().enrolled()).toBe(true);

    const target = join(directory, "target.json"); await writeFile(target, JSON.stringify(valid), { mode: 0o600 });
    await rm(file); await symlink(target, file); throwsWith(open, "invalid-store");
  });

  test("refuses a parent directory writable by other users", async () => {
    const directory = await scratch(); await chmod(directory, 0o777);
    throwsWith(() => new FilePasskeys({ file: join(directory, "passkey.json"), origin: ORIGIN, owner: OWNER }), "invalid-store");
  });
});

describe("FilePasskeys owner recovery", () => {
  test("failed recovery preserves the old passkey and verified recovery replaces it", async () => {
    const file = join(await scratch(), "passkey.json");
    const { passkeys, authenticator: previous } = await enrolled(file);
    const before = await readFile(file, "utf8"), replacement = new FakeAuthenticator();
    const options = await passkeys.recoveryOptions();
    await rejectsWith(passkeys.replace(options.challenge, replacement.register("wrong-challenge")), "verification-failed");
    expect(await readFile(file, "utf8")).toBe(before);
    await passkeys.authenticate("old-still-works", previous.assert("old-still-works"));
    await passkeys.replace(options.challenge, replacement.register(options.challenge));
    await rejectsWith(passkeys.authenticate("old-no-longer-works", previous.assert("old-no-longer-works")), "verification-failed");
    const reloaded = new FilePasskeys({ file, origin: ORIGIN, owner: OWNER });
    await reloaded.authenticate("new-works", replacement.assert("new-works"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("explicit origin recovery preserves old bytes until new-origin registration verifies", async () => {
    const file = join(await scratch(), "passkey.json"); await enrolled(file);
    const before = await readFile(file, "utf8"), origin = "https://relocated.example.net", rpID = "relocated.example.net";
    throwsWith(() => new FilePasskeys({ file, origin, owner: OWNER }), "identity-mismatch");
    const recovery = new FilePasskeys({ file, origin, owner: OWNER, allowOriginRecovery: true });
    expect(await readFile(file, "utf8")).toBe(before);
    await rejectsWith(recovery.authenticationOptions(), "identity-mismatch");
    const replacement = new FakeAuthenticator(), options = await recovery.recoveryOptions();
    await recovery.replace(options.challenge, replacement.register(options.challenge, { origin, rpID }));
    const reloaded = new FilePasskeys({ file, origin, owner: OWNER });
    await reloaded.authenticate("relocated", replacement.assert("relocated", { origin, rpID }));
    throwsWith(() => new FilePasskeys({ file, origin: ORIGIN, owner: OWNER }), "identity-mismatch");
  });
});
