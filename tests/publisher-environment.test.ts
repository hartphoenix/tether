import { expect, test } from 'bun:test';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Metadata, MetadataKind } from '@tufjs/models';
import { publisherDocument, publisherVault, keychainVaultName } from '../scripts/releases/environment-vault';
import { initializePublisher, approveRelease, inspectArchive, renewPublisher } from '../scripts/releases/publisher';
import { archiveFixture } from './fixtures/publisher';

function fixture() {
  const key = generateKeyPairSync('ed25519');
  const document = JSON.stringify({format:1,purpose:'tether-publisher',privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}).toString()});
  return {key,env:{TETHER_PUBLISHER_DOCUMENT:document}};
}
test('Keychain environment initializes the same publisher, approves archives and renews without 1Password', async () => {
  const parent = await mkdtemp(join(tmpdir(),'tether-keychain-env-'));
  const f = fixture(), vault = publisherVault(f.env), state=join(parent,'state');
  try {
    const bytes=publisherDocument(f.env);
    await initializePublisher({directory:state,vault:keychainVaultName,metadataUrl:'https://example.com/metadata/',targetsUrl:'https://example.com/targets/',publisherDocument:bytes},vault);
    expect(bytes.every(byte=>byte===0)).toBe(true);
    const root=Metadata.fromJSON(MetadataKind.Root,JSON.parse(await readFile(join(state,'public/metadata/1.root.json'),'utf8')));
    const expected=Buffer.from(createPublicKey(f.key.privateKey).export({format:'jwk'}).x!,'base64url').toString('hex');
    const rootKey=root.signed.keys[root.signed.roles.root!.keyIDs[0]!]!;
    expect(rootKey.keyVal.public===expected).toBe(true);
    root.verifyDelegate('root',root);
    const archive=await archiveFixture(parent);
    await approveRelease(state,archive,(await inspectArchive(archive)).sha256,vault);
    const targets=Metadata.fromJSON(MetadataKind.Targets,JSON.parse(await readFile(join(state,'public/metadata/2.targets.json'),'utf8')));
    root.verifyDelegate('targets',targets);
    await renewPublisher(state,vault);
    for await(const path of new Bun.Glob('**/*').scan({cwd:state,onlyFiles:true})) {
      const data=await readFile(join(state,path));
      expect(data.includes(Buffer.from(JSON.parse(f.env.TETHER_PUBLISHER_DOCUMENT).privateKey))).toBe(false);
    }
  } finally {delete (f.env as NodeJS.ProcessEnv).TETHER_PUBLISHER_DOCUMENT;await rm(parent,{recursive:true,force:true});}
});
test('missing, invalid, wrong-key and wrong-item environments fail closed',async()=>{
  for(const value of [undefined,'{}','x'.repeat(32769)]) expect(()=>publisherDocument({TETHER_PUBLISHER_DOCUMENT:value})).toThrow();
  const f=fixture(),other=fixture(),vault=publisherVault(f.env);
  const expected=await vault.create(keychainVaultName,'unused',publisherDocument(f.env));
  expect(expected).toBe('com.hartphoenix.tether.publisher');
  await expect(vault.create(keychainVaultName,'unused',publisherDocument(other.env))).rejects.toThrow('does not match');
  await expect(vault.read(keychainVaultName,'other')).rejects.toThrow('Unexpected');
  await expect(publisherVault({}).read(keychainVaultName,expected)).rejects.toThrow('Keychain helper');
});
