import { mkdtemp, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializePublisher, approveRelease, inspectArchive } from '../../scripts/releases/publisher';
import type { PublisherVault } from '../../scripts/releases/vault';
export async function publisherFixture(now = Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), 'tether-publisher-'));
  const state = join(directory,'state');
  const documents = new Map<string,Uint8Array>();
  const counts = { create:0, read:0 };
  const vault: PublisherVault = {
    async create(_vault,_title,bytes) { counts.create++; documents.set('a'.repeat(26),new Uint8Array(bytes)); return 'a'.repeat(26); },
    async read(_vault,id) { counts.read++; const bytes=documents.get(id); if(!bytes) throw new Error('Missing fixture document'); return new Uint8Array(bytes); },
  };
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const pathname=new URL(request.url).pathname;
    if(!/^\/(metadata|targets)\/[a-zA-Z0-9._-]+$/.test(pathname)) return new Response('',{status:404});
    const file=Bun.file(join(state,'public',pathname));
    return await file.exists()?new Response(await file.arrayBuffer()):new Response('',{status:404});
  }});
  try {
    await initializePublisher({directory:state,vault:'test',metadataUrl:`http://127.0.0.1:${server.port}/metadata/`,targetsUrl:`http://127.0.0.1:${server.port}/targets/`},vault,now);
    const root=join(directory,'installation/releases/initial');
    await mkdir(root,{recursive:true}); await symlink(root,join(directory,'installation/current'));
    for(const name of ['update-root.json','update-trust.json']) await copyFile(join(state,'public/bootstrap',name),join(root,name));
    await Bun.write(join(root,'release.json'),JSON.stringify({version:'0.1.0'}));
    return {directory,state,root,vault,counts,documents,
      async publish(archive:string) { return approveRelease(state,archive,(await inspectArchive(archive)).sha256,vault); },
      async close() {server.stop(true); documents.clear(); await rm(directory,{recursive:true,force:true});},
    };
  } catch(error) {server.stop(true);await rm(directory,{recursive:true,force:true});throw error;}
}
export async function archiveFixture(directory:string, version='0.2.0') {
  const source=join(directory,`candidate-${version}`);await mkdir(source);
  await Bun.write(join(source,'release.json'),JSON.stringify({version,platform:'darwin',architecture:process.arch}));
  const path=join(directory,`${version}.tar.gz`);
  const child=Bun.spawn(['/usr/bin/tar','-czf',path,'-C',source,'.'],{stdout:'ignore',stderr:'ignore'});
  if(await child.exited!==0) throw new Error('Fixture archive failed');return path;
}
