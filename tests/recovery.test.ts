import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile, rename, mkdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { startDaemon, type TetherDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { controlRequest, controlRecentsLaunch } from '../src/server/lifecycle';
import { anchorForQuote } from '../src/server/quote-anchor';
import { bodyRevision } from '../src/core/annotation-ledger';
const directories:string[]=[]; const daemons:TetherDaemon[]=[];
afterEach(async()=>{for(const d of daemons.splice(0))await d.stop();for(const p of directories.splice(0))await rm(p,{recursive:true,force:true});});
async function fixture(){const directory=await mkdtemp('/tmp/tether-recovery-');directories.push(directory);const path=join(directory,'document.md');await writeFile(path,'# Target\n\nOriginal body.\n');const config=resolveConfig({profile:'test',runtimeDir:join(directory,'runtime'),configDir:join(directory,'config')});return {directory,path:await realpath(path),config};}
async function launch(daemon:TetherDaemon,path:string){const grant=await daemon.service.open(path);const response=await fetch(daemon.mintTicket(grant).url,{redirect:'manual'});return {grant,location:response.headers.get('location')!,cookie:response.headers.get('set-cookie')!.split(';')[0]};}
function post(d:TetherDaemon,location:string,cookie:string,route:string,body:unknown){return fetch(new URL(route,d.origin+location),{method:'POST',headers:{cookie,origin:d.origin,'content-type':'application/json'},body:JSON.stringify(body)});}

test('restart retains scoped reader and Folio access, draft, position, and private review',async()=>{
 const f=await fixture();let daemon=await startDaemon({config:f.config,web:()=>new Response('reader')});daemons.push(daemon);
 const s=await launch(daemon,f.path);const doc=await daemon.service.read(s.grant);
 await daemon.service.appendComment({session:s.grant,actor:'hart',body:'Private note',anchor:anchorForQuote(doc.body,'Target',doc.bodyRevision),expectedBodyRevision:doc.bodyRevision});
 expect((await post(daemon,s.location,s.cookie,'api/draft',{body:'Recovered body',baseRevision:doc.bodyRevision,scroll:123})).status).toBe(200);
 expect((await post(daemon,s.location,s.cookie,'api/position',{scroll:456})).status).toBe(200);
 const folio=await controlRecentsLaunch(f.config);const exchange=await fetch(folio.url,{redirect:'manual'});const fl=exchange.headers.get('location')!,fc=exchange.headers.get('set-cookie')!.split(';')[0];
 const beforeOrigin=daemon.origin;
 const views=daemon.service.store.db.query('SELECT verifier FROM reader_views').all();expect(JSON.stringify(views)).not.toContain(s.cookie.split('=')[1]);
 await daemon.stop();
 daemon=await startDaemon({config:f.config,web:()=>new Response('reader')});daemons.push(daemon);
 expect(daemon.origin).toBe(beforeOrigin);
 const response=await fetch(new URL('api/bootstrap',daemon.origin+s.location),{headers:{cookie:s.cookie}});expect(response.status).toBe(200);
 const data=await response.json() as any;
 expect(data.draft.body).toBe('Recovered body');expect(data.scroll).toBe(456);expect(data.document.annotations.threads[0].comment.body).toBe('Private note');
 expect((await fetch(new URL('api/bootstrap',daemon.origin+s.location))).status).toBe(401);
 expect((await fetch(new URL('api/snapshot',daemon.origin+fl),{headers:{cookie:fc}})).status).toBe(200);
 expect(await readFile(f.path,'utf8')).toBe(doc.body);
});

test('immediate archive invalidates a live view rather than resurrecting deleted data',async()=>{
 const f=await fixture();const daemon=await startDaemon({config:f.config,web:()=>new Response('reader')});daemons.push(daemon);const s=await launch(daemon,f.path);
 const pending=daemon.mintTicket(await daemon.service.open(f.path));
 await controlRequest(f.config,'/control/folio/settings',{retention:{mode:'immediate'},confirmed:true});
 await controlRequest(f.config,'/control/folio/archive',{paths:[f.path],confirmed:true});
 expect((await post(daemon,s.location,s.cookie,'api/lease',{clientId:'test'})).status).toBe(401);
 expect((await fetch(pending.url,{redirect:'manual'})).status).toBe(401);
 const list=await controlRequest<any>(f.config,'/control/folio/list',{view:'all'});expect(list.files).toHaveLength(0);
 expect(await readFile(f.path,'utf8')).toContain('Original body');
});

test('start fresh clears conversation while retaining file, Folio entry, and active reader',async()=>{
 const f=await fixture();const daemon=await startDaemon({config:f.config,web:()=>new Response('reader')});daemons.push(daemon);const s=await launch(daemon,f.path);const doc=await daemon.service.read(s.grant);
 await daemon.service.appendComment({session:s.grant,actor:'hart',body:'Private note',anchor:anchorForQuote(doc.body,'Target',doc.bodyRevision),expectedBodyRevision:doc.bodyRevision});
 await post(daemon,s.location,s.cookie,'api/draft',{body:'Unsaved document work',baseRevision:doc.bodyRevision,scroll:17});
 await controlRequest(f.config,'/control/folio/start-fresh',{paths:[f.path],confirmed:true});
 const list=await controlRequest<any>(f.config,'/control/folio/list',{view:'active'});expect(list.files).toHaveLength(1);
 const response=await fetch(new URL('api/bootstrap',daemon.origin+s.location),{headers:{cookie:s.cookie}});expect(response.status).toBe(200);const recovered=await response.json() as any;expect(recovered.document.annotations.threads).toHaveLength(0);expect(recovered.draft.body).toBe('Unsaved document work');
});

test('comment retry returns its receipt after the quoted text changes',async()=>{
 const f=await fixture();const daemon=await startDaemon({config:f.config,web:()=>new Response('reader')});daemons.push(daemon);
 const request={path:f.path,actor:'assistant',body:'A note',quote:'Target',operationId:'stable-comment'};
 const first=await controlRequest<any>(f.config,'/control/review/comment',request);
 await writeFile(f.path,'Completely different document\n');
 const replay=await controlRequest<any>(f.config,'/control/review/comment',request);
 expect(replay.mutation.appliedEventId).toBe(first.mutation.appliedEventId);expect(replay.mutation.replayed).toBe(true);
});

test('quote anchoring ignores Markdown decorations and rejects ambiguous quotations',()=>{
 const body='# A title\n\nA **strong** word.\n\n```ts\nconst n = 1;\n```\n';
 expect(anchorForQuote(body,'strong',bodyRevision(body)).projectionStart).toBe(10);
 expect(()=>anchorForQuote('same\n\nsame\n','same',bodyRevision('same\n\nsame\n'))).toThrow('more than once');
});


test('restored viewer grants reject file symlinks and parent-directory replacement', async () => {
  for (const replacement of ['symlink', 'parent']) {
    const f = await fixture();
    const docs = join(f.directory, 'docs'); await mkdir(docs);
    const path = await realpath(docs) + '/nested.md'; await writeFile(path, 'Original');
    let daemon = await startDaemon({config: f.config, web: () => new Response('reader')}); daemons.push(daemon);
    const view = await launch(daemon, path); await daemon.stop();
    if (replacement === 'symlink') { await unlink(path); await symlink(f.path, path); }
    else { await rename(docs, join(f.directory, 'old-docs')); await mkdir(docs); await writeFile(path, 'Redirected'); }
    daemon = await startDaemon({config: f.config, web: () => new Response('reader')}); daemons.push(daemon);
    const response = await fetch(new URL('api/bootstrap', daemon.origin + view.location), {headers: {cookie: view.cookie}});
    expect(response.status).toBe(401);
  }
});
