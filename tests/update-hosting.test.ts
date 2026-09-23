import { expect, test } from 'bun:test';
import { cp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publisherFixture, archiveFixture } from './fixtures/publisher';
import { checkLiveMetadata, checkHostedTargets, refreshHostedMetadata } from '../scripts/update-hosting';

test('hosted refresh preserves approved targets without publisher access and removes temporary keys', async () => {
  const f = await publisherFixture();
  try {
    await f.publish(await archiveFixture(f.directory));
    const directory = join(f.directory, 'hosted');
    await mkdir(directory);
    await cp(join(f.state, 'public'), join(directory, 'public'), { recursive: true });
    const bytes = await readFile(join(f.root, 'update-root.json'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const keys = await readFile(join(f.state, 'service-keys.json'), 'utf8');
    const targets = await readFile(join(directory, 'public/metadata/2.targets.json'), 'utf8');
    const reads = f.counts.read;
    await refreshHostedMetadata(directory, hash, keys);
    expect(f.counts.read).toBe(reads);
    expect(await readFile(join(directory, 'public/metadata/2.targets.json'), 'utf8')).toBe(targets);
    expect(JSON.parse(await readFile(join(directory, 'public/metadata/timestamp.json'), 'utf8')).signed.version).toBe(3);
    expect(await stat(join(directory, 'service-keys.json')).catch(() => null)).toBeNull();
    expect(await stat(join(directory, 'publisher.json')).catch(() => null)).toBeNull();
    expect((await checkLiveMetadata(join(directory, 'public'), hash)).verified).toBe(true);
    expect((await checkHostedTargets(join(directory, 'public'), hash)).available).toBe(1);
    await rm(join(f.state, 'public/targets'), { recursive: true });
    await expect(checkHostedTargets(join(directory, 'public'), hash)).rejects.toThrow('unavailable');
    await expect(checkLiveMetadata(join(directory, 'public'), hash, 25)).rejects.toThrow('near expiry');
    await expect(refreshHostedMetadata(directory, '0'.repeat(64), keys)).rejects.toThrow('trust hash');
    await expect(refreshHostedMetadata(directory, hash, JSON.stringify({ ...JSON.parse(keys), privateKey: 'forbidden' }))).rejects.toThrow('service key');
  } finally { await f.close(); }
});

test('hosted refresh rejects tampered approvals and cleans its service state on failure', async () => {
  const f = await publisherFixture();
  try {
    const directory = join(f.directory, 'hosted'); await mkdir(directory);
    await cp(join(f.state, 'public'), join(directory, 'public'), { recursive: true });
    const hash = createHash('sha256').update(await readFile(join(f.root, 'update-root.json'))).digest('hex');
    const before = await readFile(join(directory, 'public/metadata/timestamp.json'), 'utf8');
    await Bun.write(join(directory, 'public/metadata/1.targets.json'), '{}');
    await expect(refreshHostedMetadata(directory, hash, await readFile(join(f.state, 'service-keys.json'), 'utf8'))).rejects.toThrow();
    expect(await readFile(join(directory, 'public/metadata/timestamp.json'), 'utf8')).toBe(before);
    expect(await stat(join(directory, 'service-keys.json')).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});
