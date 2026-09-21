import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Key, Metadata, MetadataKind, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";
import { acquireFileLock } from "../../src/documents/path-lock";
import { newerVersion } from "../../src/releases/verified-update";
import type { PublisherVault } from "./vault";

const day = 86400_000, specVersion = "1.0.31";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const expires = (days: number, now: number) => new Date(now + days * day).toISOString();
type SigningKey = { public: Key; private: KeyObject };
type Settings = { format: 1; vault: string; item: string; publicKey: string; metadataUrl: string; targetsUrl: string };
type Signed = Root | Targets | Snapshot | Timestamp;
function fromPrivate(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 signing key.");
  const publicHex = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x!, "base64url").toString("hex");
  return { private: privateKey, public: new Key({ keyID: hash(publicHex), keyType: "ed25519", scheme: "ed25519", keyVal: { public: publicHex } }) };
}
function generate(): SigningKey { return fromPrivate(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()); }
function pem(key: SigningKey): string { return key.private.export({ type: "pkcs8", format: "pem" }).toString(); }
function signed<T extends Signed>(value: T, key: SigningKey): Metadata<T> {
  const result = new Metadata(value);
  result.sign(data => new Signature({ keyID: key.public.keyID, sig: sign(null, data, key.private).toString("hex") }));
  return result;
}
const encode = (value: Metadata<Signed>) => JSON.stringify(value.toJSON()) + "\n";
function url(input: string): string {
  const parsed = new URL(input);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1")) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Repository URLs require HTTPS (or isolated loopback HTTP), without credentials.");
  return parsed.href.endsWith("/") ? parsed.href : parsed.href + "/";
}
async function exclusive(path: string, bytes: string | Uint8Array, mode = 0o600) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function atomic(path: string, bytes: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await exclusive(temporary, bytes, 0o644); await rename(temporary, path);
  const directory = await open(resolve(path, ".."), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Publisher state must be an owned private directory (0700).");
}
async function privateJson(path: string): Promise<any> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32768 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Unsafe private publisher file.");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
function parseKey(bytes: Uint8Array): SigningKey {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString());
    if (value.format !== 1 || value.purpose !== "tether-publisher") throw new Error();
    return fromPrivate(value.privateKey);
  } catch { throw new Error("Invalid publisher document; no key contents were logged."); }
  finally { bytes.fill(0); }
}
async function nextVersion(metadata: string, role: string): Promise<number> {
  const versions = (await readdir(metadata)).flatMap(name => {
    const match = new RegExp(`^(\\d+)\\.${role}\\.json$`).exec(name); return match ? [Number(match[1])] : [];
  });
  const version = Math.max(0, ...versions) + 1;
  if (!Number.isSafeInteger(version)) throw new Error("Metadata version exhausted.");
  return version;
}
async function loadRoot(directory: string, settings: Settings, now: number) {
  const metadata = join(directory, "public/metadata");
  const version = await nextVersion(metadata, "root") - 1;
  const root = Metadata.fromJSON(MetadataKind.Root, JSON.parse(await readFile(join(metadata, `${version}.root.json`), "utf8")));
  const key = root.signed.keys[hash(settings.publicKey)];
  if (!key || key.keyVal.public !== settings.publicKey) throw new Error("Publisher root changed unexpectedly.");
  key.verifySignature(root); root.verifyDelegate("root", root);
  if (root.signed.isExpired(new Date(now))) throw new Error("Publisher root expired; renew it with the publisher credential.");
  return root;
}
async function serviceKeys(directory: string) {
  const data = await privateJson(join(directory, "service-keys.json"));
  try { return { snapshot: fromPrivate(data.snapshot), timestamp: fromPrivate(data.timestamp) }; }
  catch { throw new Error("Invalid service signing material."); }
}
async function currentTargets(directory: string, root: Metadata<Root>, now: number, allowExpired = false): Promise<Metadata<Targets>> {
  const metadata = join(directory, "public/metadata");
  const timestamp = Metadata.fromJSON(MetadataKind.Timestamp, JSON.parse(await readFile(join(metadata, "timestamp.json"), "utf8")));
  root.verifyDelegate("timestamp", timestamp);
  const snapshotBytes = await readFile(join(metadata, `${timestamp.signed.snapshotMeta.version}.snapshot.json`));
  timestamp.signed.snapshotMeta.verify(snapshotBytes);
  const snapshot = Metadata.fromJSON(MetadataKind.Snapshot, JSON.parse(snapshotBytes.toString())); root.verifyDelegate("snapshot", snapshot);
  const targetBytes = await readFile(join(metadata, `${snapshot.signed.meta["targets.json"]!.version}.targets.json`));
  snapshot.signed.meta["targets.json"]!.verify(targetBytes);
  const targets = Metadata.fromJSON(MetadataKind.Targets, JSON.parse(targetBytes.toString())); root.verifyDelegate("targets", targets);
  if (!allowExpired && targets.signed.isExpired(new Date(now))) throw new Error("Release approvals expired; publisher approval is required. Freshness keys cannot extend them.");
  return targets;
}
async function refreshMetadata(directory: string, root: Metadata<Root>, targets: Metadata<Targets>, now: number) {
  root.verifyDelegate("targets", targets);
  const keys = await serviceKeys(directory), metadata = join(directory, "public/metadata");
  const version = await nextVersion(metadata, "snapshot");
  const targetBytes = encode(targets);
  const snapshot = signed(new Snapshot({ specVersion, version, expires: expires(7, now), meta: { "targets.json": new MetaFile({ version: targets.signed.version, length: Buffer.byteLength(targetBytes), hashes: { sha256: hash(targetBytes) } }) } }), keys.snapshot);
  root.verifyDelegate("snapshot", snapshot);
  const snapshotBytes = encode(snapshot);
  const timestamp = signed(new Timestamp({ specVersion, version, expires: expires(1, now), snapshotMeta: new MetaFile({ version, length: Buffer.byteLength(snapshotBytes), hashes: { sha256: hash(snapshotBytes) } }) }), keys.timestamp);
  root.verifyDelegate("timestamp", timestamp);
  await exclusive(join(metadata, `${version}.snapshot.json`), snapshotBytes, 0o644);
  // Commit point: immutable referenced files exist before the new timestamp appears.
  await atomic(join(metadata, "timestamp.json"), encode(timestamp));
  return { version, expires: timestamp.signed.expires };
}
export async function initializePublisher(input: { directory: string; vault: string; metadataUrl: string; targetsUrl: string; publisherDocument?: Uint8Array }, vault: PublisherVault, now = Date.now()) {
  const metadataUrl = url(input.metadataUrl), targetsUrl = url(input.targetsUrl);
  await mkdir(input.directory, { mode: 0o700 }); await privateDirectory(input.directory);
  const publisher = input.publisherDocument ? parseKey(input.publisherDocument) : generate();
  const snapshot = generate(), timestamp = generate();
  const title = `Tether publisher ${crypto.randomUUID()}`;
  // Recovery intent is durable before the only external mutation. Never retry init over it.
  await exclusive(join(input.directory, "setup.json"), JSON.stringify({ vault: input.vault, title, publicKey: publisher.public.keyVal.public }));
  const contents = Buffer.from(JSON.stringify({ format: 1, purpose: "tether-publisher", privateKey: pem(publisher) }));
  let item: string;
  try {
    item = await vault.create(input.vault, title, contents);
    const restored = parseKey(await vault.read(input.vault, item));
    if (restored.public.keyID !== publisher.public.keyID) throw new Error("Vault verification failed.");
  } catch { throw new Error("Initialization incomplete. Inspect setup.json and the named vault item before retrying; it may already exist."); }
  finally { contents.fill(0); }
  const settings: Settings = { format: 1, vault: input.vault, item, publicKey: publisher.public.keyVal.public!, metadataUrl, targetsUrl };
  await exclusive(join(input.directory, "publisher.json"), JSON.stringify(settings));
  await exclusive(join(input.directory, "service-keys.json"), JSON.stringify({ format: 1, snapshot: pem(snapshot), timestamp: pem(timestamp) }));
  const metadata = join(input.directory, "public/metadata");
  await mkdir(metadata, { recursive: true, mode: 0o755 }); await mkdir(join(input.directory, "public/targets")); await mkdir(join(input.directory, "public/bootstrap"));
  const value = new Root({ specVersion, version: 1, expires: expires(365, now), consistentSnapshot: true });
  value.addKey(publisher.public, "root"); value.addKey(publisher.public, "targets"); value.addKey(snapshot.public, "snapshot"); value.addKey(timestamp.public, "timestamp");
  const root = signed(value, publisher), rootBytes = encode(root);
  await exclusive(join(metadata, "1.root.json"), rootBytes, 0o644);
  await exclusive(join(input.directory, "public/bootstrap/update-root.json"), rootBytes, 0o644);
  await exclusive(join(input.directory, "public/bootstrap/update-trust.json"), JSON.stringify({ metadataUrl, targetsUrl }), 0o644);
  const targets = signed(new Targets({ specVersion, version: 1, expires: expires(90, now), targets: {} }), publisher);
  await exclusive(join(metadata, "1.targets.json"), encode(targets), 0o644);
  await refreshMetadata(input.directory, root, targets, now);
  return { directory: input.directory, vault: input.vault, item, publicDirectory: join(input.directory, "public"), rootSha256: hash(rootBytes) };
}
async function locked<T>(directory: string, action: (settings: Settings) => Promise<T>): Promise<T> {
  await privateDirectory(directory);
  const lock = await acquireFileLock(join(directory, "writer.lock"));
  try { return await action(await privateJson(join(directory, "publisher.json"))); } finally { await lock.release(); }
}
export async function inspectArchive(path: string) {
  const file = Bun.file(path);
  if (!file.size || file.size > 512 * 1024 * 1024) throw new Error("Archive must be between 1 byte and 512 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw new Error("Archive changed size while reading.");
  // System tar reads only the manifest; no candidate code executes or extracts to disk.
  const child = Bun.spawn(["/usr/bin/tar", "-xzOf", "-", "./release.json"], { stdin: new Blob([bytes]), stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const reader = child.stdout.getReader(); let manifest = "";
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; if (manifest.length + value.length > 8192) { child.kill(); throw new Error("Invalid release manifest size."); } manifest += Buffer.from(value).toString(); }
  } finally { reader.releaseLock(); }
  if (await child.exited !== 0) throw new Error("Archive does not contain a release manifest.");
  let value: any; try { value = JSON.parse(manifest); } catch { throw new Error("Invalid release manifest."); }
  if (!/^\d+\.\d+\.\d+$/.test(value.version) || value.platform !== "darwin" || !["arm64", "x64"].includes(value.architecture)) throw new Error("Invalid release version, platform, or architecture.");
  return { bytes, sha256: hash(bytes), version: value.version as string, platform: value.platform as string, architecture: value.architecture as string };
}
export async function approveRelease(directory: string, archive: string, approvedHash: string, vault: PublisherVault, now = Date.now()) {
  return locked(directory, async settings => {
    const candidate = await inspectArchive(archive);
    if (!/^[a-f0-9]{64}$/.test(approvedHash) || candidate.sha256 !== approvedHash) throw new Error("Archive differs from the explicitly approved SHA-256.");
    const root = await loadRoot(directory, settings, now);
    const previous = await currentTargets(directory, root, now, true);
    const name = `tether-${candidate.platform}-${candidate.architecture}.tar.gz`;
    const existing = previous.signed.targets[name];
    if (existing && !newerVersion(candidate.version, String(existing.custom.version))) throw new Error("Release must advance the approved version for this architecture.");
    const publisher = parseKey(await vault.read(settings.vault, settings.item));
    if (publisher.public.keyVal.public !== settings.publicKey) throw new Error("Publisher key does not match the installed trust root.");
    const metadata = join(directory, "public/metadata"), version = await nextVersion(metadata, "targets");
    const targets = signed(new Targets({ specVersion, version, expires: expires(90, now), targets: { ...previous.signed.targets, [name]: new TargetFile({ path: name, length: candidate.bytes.length, hashes: { sha256: candidate.sha256 }, unrecognizedFields: { custom: { version: candidate.version, platform: candidate.platform, architecture: candidate.architecture } } }) } }), publisher);
    root.verifyDelegate("targets", targets);
    const destination = join(directory, "public/targets", `${candidate.sha256}.${name}`);
    try { await exclusive(destination, candidate.bytes, 0o644); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readFile(destination)) !== candidate.sha256) throw new Error("Candidate archive publication failed; previous timestamp remains authoritative."); }
    await exclusive(join(metadata, `${version}.targets.json`), encode(targets), 0o644);
    await refreshMetadata(directory, root, targets, now);
    return { version: candidate.version, sha256: candidate.sha256, target: name, metadataVersion: version, publicDirectory: join(directory, "public") };
  });
}
export async function refreshPublisher(directory: string, now = Date.now()) {
  return locked(directory, async settings => {
    const root = await loadRoot(directory, settings, now);
    return refreshMetadata(directory, root, await currentTargets(directory, root, now), now);
  });
}

export async function renewPublisher(directory: string, vault: PublisherVault, now = Date.now()) {
  return locked(directory, async settings => {
    const metadata = join(directory, "public/metadata");
    const oldVersion = await nextVersion(metadata, "root") - 1;
    const old = Metadata.fromJSON(MetadataKind.Root, JSON.parse(await readFile(join(metadata, `${oldVersion}.root.json`), "utf8")));
    const publisher = parseKey(await vault.read(settings.vault, settings.item));
    if (publisher.public.keyVal.public !== settings.publicKey) throw new Error("Publisher credential changed.");
    publisher.public.verifySignature(old); old.verifyDelegate("root", old);
    const targets = await currentTargets(directory, old, now, true);
    const root = signed(new Root({ specVersion, version: oldVersion + 1, expires: expires(365, now), consistentSnapshot: true, keys: old.signed.keys, roles: old.signed.roles }), publisher);
    old.verifyDelegate("root", root); root.verifyDelegate("root", root);
    const next = signed(new Targets({ specVersion, version: await nextVersion(metadata, "targets"), expires: expires(90, now), targets: targets.signed.targets }), publisher);
    root.verifyDelegate("targets", next);
    await exclusive(join(metadata, `${root.signed.version}.root.json`), encode(root), 0o644);
    await exclusive(join(metadata, `${next.signed.version}.targets.json`), encode(next), 0o644);
    return refreshMetadata(directory, root, next, now);
  });
}
