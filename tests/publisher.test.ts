import { expect, test } from 'bun:test';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { approveRelease, initializePublisher, inspectArchive, refreshPublisher, renewPublisher } from '../scripts/releases/publisher';
import { discoverVerifiedRelease, withVerifiedRelease } from '../src/releases/verified-update';
import { publisherFixture, archiveFixture } from './fixtures/publisher';
const day=86400000;
test('publisher approval produces a verifiable download with separate service authority',async()=>{
  const f=await publisherFixture();try{
    const root=JSON.parse(await readFile(join(f.root,'update-root.json'),'utf8')).signed;
    expect(root.roles.root).toEqual(root.roles.targets);
    expect(root.roles.root.threshold).toBe(1);
    expect(root.roles.timestamp.keyids).not.toEqual(root.roles.root.keyids);
    expect(root.roles.snapshot.keyids).not.toEqual(root.roles.timestamp.keyids);
    const archive=await archiveFixture(f.directory);const inspected=await inspectArchive(archive);
    await approveRelease(f.state,archive,inspected.sha256,f.vault);
    expect((await discoverVerifiedRelease(f.root))?.version).toBe('0.2.0');
    await withVerifiedRelease(f.root,async(_,download)=>{expect(Buffer.compare(await readFile(await download()),await readFile(archive))).toBe(0);});
    const reads=f.counts.read;await refreshPublisher(f.state);expect(f.counts.read).toBe(reads);
    for(const name of ['publisher.json','setup.json','service-keys.json']) expect((await stat(join(f.state,name))).mode&0o077).toBe(0);
    const publisherBytes=f.documents.values().next().value!;
    const privateKey=JSON.parse(Buffer.from(publisherBytes).toString()).privateKey;
    for await(const path of new Bun.Glob('**/*').scan({cwd:f.state,onlyFiles:true})) {
      // Boolean assertion deliberately avoids printing any key on failure.
      expect((await readFile(join(f.state,path),'utf8')).includes(privateKey)).toBe(false);
    }
  }finally{await f.close();}
});
test('hash mismatch and repeated versions fail before opening the publisher vault',async()=>{
  const f=await publisherFixture();try{
    const archive=await archiveFixture(f.directory),reads=f.counts.read;
    await expect(approveRelease(f.state,archive,'0'.repeat(64),f.vault)).rejects.toThrow('explicitly approved');expect(f.counts.read).toBe(reads);
    await f.publish(archive);const after=f.counts.read;
    await expect(f.publish(archive)).rejects.toThrow('advance');expect(f.counts.read).toBe(after);
    await chmod(f.state,0o755);await expect(refreshPublisher(f.state)).rejects.toThrow('private directory');await chmod(f.state,0o700);
  }finally{await f.close();}
});
test('service refresh cannot extend expired approvals; publisher renewal restores client updates',async()=>{
  const f=await publisherFixture(Date.now()-400*day);try{
    const reads=f.counts.read;await expect(refreshPublisher(f.state)).rejects.toThrow('root expired');expect(f.counts.read).toBe(reads);
    await renewPublisher(f.state,f.vault);
    await f.publish(await archiveFixture(f.directory));
    expect((await discoverVerifiedRelease(f.root))?.version).toBe('0.2.0');
    await expect(refreshPublisher(f.state,Date.now()+91*day)).rejects.toThrow('approvals expired');
  }finally{await f.close();}
});
test('tampered approvals and publisher mismatch cannot replace the public timestamp',async()=>{
  const f=await publisherFixture();try{
    const path=join(f.state,'public/metadata/timestamp.json'),before=await readFile(path,'utf8');
    const good=f.documents.get('a'.repeat(26))!;f.documents.set('a'.repeat(26),new TextEncoder().encode('{}'));
    await expect(f.publish(await archiveFixture(f.directory))).rejects.toThrow('Invalid publisher');expect(await readFile(path,'utf8')).toBe(before);
    f.documents.set('a'.repeat(26),good);
    const target=join(f.state,'public/metadata/1.targets.json');await writeFile(target,(await readFile(target,'utf8')).replace('"version":1','"version":2'));
    await expect(refreshPublisher(f.state)).rejects.toThrow();expect(await readFile(path,'utf8')).toBe(before);
  }finally{await f.close();}
});
test('interrupted initialization records intent and cannot create duplicate vault items',async()=>{
  const f=await publisherFixture();try{
    const directory=join(f.directory,'interrupted');let creates=0;
    const vault={async create(){creates++;throw new Error('unknown outcome');},async read(){throw new Error('unexpected');}};
    const args={directory,vault:'test',metadataUrl:'https://example.com/metadata/',targetsUrl:'https://example.com/targets/'};
    await expect(initializePublisher(args,vault)).rejects.toThrow('may already exist');
    expect(await readdir(directory)).toEqual(['setup.json']);
    await expect(initializePublisher(args,vault)).rejects.toThrow();expect(creates).toBe(1);
  }finally{await f.close();}
});
test('orphaned metadata versions are skipped and concurrent approvals serialize',async()=>{
  const f=await publisherFixture();try{
    await writeFile(join(f.state,'public/metadata/2.targets.json'),'interrupted');
    await writeFile(join(f.state,'public/metadata/2.snapshot.json'),'interrupted');
    const archive=await archiveFixture(f.directory);
    const results=await Promise.allSettled([f.publish(archive),f.publish(archive)]);
    expect(results.filter(r=>r.status==='fulfilled').length).toBe(1);
    expect((await discoverVerifiedRelease(f.root))?.version).toBe('0.2.0');
  }finally{await f.close();}
});
