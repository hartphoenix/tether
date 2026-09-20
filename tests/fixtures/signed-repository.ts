import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { Key, Metadata, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";

/** Ephemeral test publisher. Private signing keys never leave memory. */
export async function signedRepository() {
  const directory = await mkdtemp("/tmp/tether-signed-repository-");
  const root = join(directory, "releases/current");
  await mkdir(root, { recursive: true }); await symlink(root, join(directory, "current"));
  await writeFile(join(directory, "install.json"), "{}");
  await writeFile(join(root, "release.json"), JSON.stringify({ version: "0.1.0", platform: process.platform, architecture: process.arch }));
  const files = new Map<string, string | Uint8Array>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const content = files.get(new URL(request.url).pathname.slice(1));
    return content === undefined ? new Response("Missing", { status: 404 }) : new Response(typeof content === "string" ? content : Buffer.from(content));
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(root, "update-trust.json"), JSON.stringify({ metadataUrl: `${origin}/metadata/`, targetsUrl: `${origin}/targets/` }));
  const expires = () => new Date(Date.now() + 86400_000).toISOString();
  const makeKeys = () => Object.fromEntries(["root", "timestamp", "snapshot", "targets"].map(role => {
    const pair = generateKeyPairSync("ed25519");
    const publicHex = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
    const key = new Key({ keyID: createHash("sha256").update(publicHex).digest("hex"), keyType: "ed25519", scheme: "ed25519", keyVal: { public: publicHex } });
    return [role, { key, privateKey: pair.privateKey }];
  }));
  let keys = makeKeys();
  const signed = (metadata: Metadata<any>, role: string, source = keys) => {
    const entry = source[role]!;
    metadata.sign(data => new Signature({ keyID: entry.key.keyID, sig: sign(null, data, entry.privateKey).toString("hex") }), true);
    return JSON.stringify(metadata.toJSON());
  };
  const makeRoot = (version: number) => {
    const value = new Root({ specVersion: "1.0.31", version, expires: expires(), consistentSnapshot: false });
    for (const [role, entry] of Object.entries(keys)) value.addKey(entry.key, role);
    return new Metadata(value);
  };
  await writeFile(join(root, "update-root.json"), signed(makeRoot(1), "root"));
  let sequence = 0;
  function publish(version = "0.2.0", options: { archive?: Uint8Array; expires?: string; platform?: string; architecture?: string } = {}) {
    sequence++;
    const archive = options.archive ?? Buffer.from("verified archive fixture");
    const name = `tether-${process.platform}-${process.arch}.tar.gz`;
    const target = new TargetFile({ path: name, length: archive.length, hashes: { sha256: createHash("sha256").update(archive).digest("hex") }, unrecognizedFields: { custom: { version, platform: options.platform ?? process.platform, architecture: options.architecture ?? process.arch } } });
    files.set(`targets/${name}`, archive);
    const targets = signed(new Metadata(new Targets({ specVersion: "1.0.31", version: sequence, expires: expires(), targets: { [name]: target } })), "targets");
    const meta = (value: string) => new MetaFile({ version: sequence, length: Buffer.byteLength(value), hashes: { sha256: createHash("sha256").update(value).digest("hex") } });
    const snapshot = signed(new Metadata(new Snapshot({ specVersion: "1.0.31", version: sequence, expires: expires(), meta: { "targets.json": meta(targets) } })), "snapshot");
    const timestamp = signed(new Metadata(new Timestamp({ specVersion: "1.0.31", version: sequence, expires: options.expires ?? expires(), snapshotMeta: meta(snapshot) })), "timestamp");
    files.set("metadata/targets.json", targets); files.set("metadata/snapshot.json", snapshot); files.set("metadata/timestamp.json", timestamp);
  }
  let rootVersion = 1;
  function rotate() {
    const previous = keys; keys = makeKeys();
    const next = makeRoot(++rootVersion);
    signed(next, "root", previous);
    files.set(`metadata/${rootVersion}.root.json`, signed(next, "root"));
  }
  publish();
  return { directory, root, origin, files, publish, rotate, close: async () => { server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}
