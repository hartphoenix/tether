import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Metadata, MetadataKind } from '@tufjs/models';
import { Updater } from 'tuf-js';
import { refreshPublisher } from './releases/publisher';

async function bootstrap(directory: string, expected: string) {
  const bytes = await readFile(join(directory, 'bootstrap/update-root.json'));
  if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Bootstrap trust hash mismatch.');
  const root = Metadata.fromJSON(MetadataKind.Root, JSON.parse(bytes.toString()));
  root.verifyDelegate('root', root);
  if (root.signed.isExpired(new Date())) throw new Error('Bootstrap root expired.');
  const trust = JSON.parse(await readFile(join(directory, 'bootstrap/update-trust.json'), 'utf8'));
  for (const value of [trust.metadataUrl, trust.targetsUrl]) {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public hosting URL.');
  }
  return { root, trust };
}

/** Reconstruct only service state. No publisher credential is available to the hosted job. */
export async function refreshHostedMetadata(directory: string, expectedRoot: string, serviceDocument: string) {
  const { root, trust } = await bootstrap(join(directory, 'public'), expectedRoot);
  if (!serviceDocument || Buffer.byteLength(serviceDocument) > 32768) throw new Error('Missing or oversized service key document.');
  let keys: any;
  try { keys = JSON.parse(serviceDocument); } catch { throw new Error('Invalid service key document.'); }
  if (keys.format !== 1 || typeof keys.snapshot !== 'string' || typeof keys.timestamp !== 'string' || Object.keys(keys).some(key => !['format', 'snapshot', 'timestamp'].includes(key))) throw new Error('Invalid service key document.');
  const publisher = root.signed.roles.targets.keyIDs;
  if (publisher.length !== 1) throw new Error('Expected one publisher identity.');
  await chmod(directory, 0o700);
  const keyPath = join(directory, 'service-keys.json');
  const settingsPath = join(directory, 'publisher.json');
  await writeFile(settingsPath, JSON.stringify({ format: 1, vault: 'service-only', item: 'unavailable', publicKey: root.signed.keys[publisher[0]!]!.keyVal.public, ...trust }), { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(keyPath, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
    try { return await refreshPublisher(directory); }
    finally { await rm(keyPath); }
  } finally { await rm(settingsPath); }
}

/** Refuse deployment until the approved public archives are reachable. */
export async function checkHostedTargets(publicDirectory: string, expectedRoot: string) {
  const { root, trust } = await bootstrap(publicDirectory, expectedRoot);
  const timestamp = Metadata.fromJSON(MetadataKind.Timestamp, JSON.parse(await readFile(join(publicDirectory, 'metadata/timestamp.json'), 'utf8')));
  root.verifyDelegate('timestamp', timestamp);
  const snapshotBytes = await readFile(join(publicDirectory, `metadata/${timestamp.signed.snapshotMeta.version}.snapshot.json`));
  timestamp.signed.snapshotMeta.verify(snapshotBytes);
  const snapshot = Metadata.fromJSON(MetadataKind.Snapshot, JSON.parse(snapshotBytes.toString()));
  root.verifyDelegate('snapshot', snapshot);
  const targetsMeta = snapshot.signed.meta['targets.json']!;
  const targetsBytes = await readFile(join(publicDirectory, `metadata/${targetsMeta.version}.targets.json`));
  targetsMeta.verify(targetsBytes);
  const targets = Metadata.fromJSON(MetadataKind.Targets, JSON.parse(targetsBytes.toString()));
  root.verifyDelegate('targets', targets);
  for (const metadata of [timestamp, snapshot, targets]) if (metadata.signed.isExpired(new Date())) throw new Error('Expired metadata.');
  const entries = Object.entries(targets.signed.targets);
  if (!entries.length) throw new Error('No approved release.');
  for (const [name, target] of entries) {
    const hash = target.hashes.sha256;
    if (!/^tether-darwin-(arm64|x64)\.tar\.gz$/.test(name) || !/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Invalid approved target.');
    const response = await fetch(new URL(`${hash}.${name}`, trust.targetsUrl), { method: 'HEAD', signal: AbortSignal.timeout(30000) });
    if (!response.ok || Number(response.headers.get('content-length')) !== target.length) throw new Error('Approved archive is unavailable or has the wrong length.');
  }
  return { available: entries.length };
}

/** An independent, read-only check of the deployed signature chain and expiry margin. */
export async function checkLiveMetadata(publicDirectory: string, expectedRoot: string, minimumHours = 6) {
  if (!Number.isFinite(minimumHours) || minimumHours < 0) throw new Error('Invalid expiry margin.');
  const { trust } = await bootstrap(publicDirectory, expectedRoot);
  const cache = await mkdtemp(join(tmpdir(), 'tether-hosting-check-'));
  try {
    await copyFile(join(publicDirectory, 'bootstrap/update-root.json'), join(cache, 'root.json'));
    const updater = new Updater({ metadataDir: cache, metadataBaseUrl: trust.metadataUrl, targetBaseUrl: trust.targetsUrl, config: { fetchTimeout: 15000, fetchRetries: 1 } });
    await updater.refresh();
    const timestamp = JSON.parse(await readFile(join(cache, 'timestamp.json'), 'utf8'));
    const remaining = Date.parse(timestamp.signed.expires) - Date.now();
    if (!Number.isFinite(remaining) || remaining < minimumHours * 3600000) throw new Error('Deployed timestamp is near expiry. Refresh and deploy update metadata.');
    return { verified: true, timestampVersion: timestamp.signed.version, expires: timestamp.signed.expires };
  } finally { await rm(cache, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [command, directory, rootHash] = process.argv.slice(2);
  try {
    if (!directory || !rootHash || !['refresh', 'check', 'assets'].includes(command ?? '')) throw new Error('Usage: update-hosting.ts refresh|check|assets <directory> <root-sha256>');
    const result = command === 'refresh' ? await refreshHostedMetadata(resolve(directory), rootHash, process.env.TETHER_UPDATE_SERVICE_KEYS ?? '') : command === 'assets' ? await checkHostedTargets(resolve(directory), rootHash) : await checkLiveMetadata(resolve(directory), rootHash);
    console.log(JSON.stringify({ ok: true, result }));
  } catch {
    console.error('Update hosting verification failed. Check service-key configuration, pinned trust, signatures, expiry, and network availability. No credential contents were logged.');
    process.exitCode = 1;
  }
}
