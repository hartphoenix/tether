import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision } from "../src/core/index";
import { DocumentService, FileAccessError, LocalFileAccess, type FileLocation, type FileAccess } from "../src/documents/index";
import type { ReaderConnection } from "../src/remote/contracts";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { controlRecentsLaunch } from "../src/server/lifecycle";
import { runCli } from "../src/cli/main";

const fixtures: Array<{root:string;daemon:TetherDaemon;service:DocumentService}> = [];
afterEach(async () => {
  for (const {root,daemon,service} of fixtures.splice(0)) {
    await daemon.stop(); service.store.close(); await rm(root,{recursive:true,force:true});
  }
});

class TestFileMachine extends LocalFileAccess {
  online = true;
  loseSaveResponse = false;
  saves = 0;
  barriers = 0;
  images = 0;
  private available() { if (!this.online) throw new FileAccessError("connector_disconnected","The test file machine is disconnected."); }
  override async inspect(path:string) { this.available(); return super.inspect(path); }
  override async bind(location:FileLocation) { this.available(); return super.bind(location); }
  override async read(location:FileLocation) { this.available(); return super.read(location); }
  override async save(location:FileLocation,input:{body:string;expectedBodyRevision:string}) {
    this.available(); this.saves++;
    const result = await super.save(location,input);
    if (this.loseSaveResponse) throw new FileAccessError("outcome_unknown","Save not yet confirmed.",503,{outcome:"unknown"});
    return result;
  }
  override async barrier(location:FileLocation) { this.available(); this.barriers++; return super.barrier(location); }
  override async image(location:FileLocation,source:string) { this.available(); this.images++; return super.image(location,source); }
}

async function fixture(remoteBody = "Remote body\n", files = new TestFileMachine()) {
  const root = await realpath(await mkdtemp("/tmp/tether-shared-library-"));
  const remoteDirectory = join(root,"file-machine"), localPath = join(root,"local.md"), remotePath = join(remoteDirectory,"remote.md");
  await mkdir(remoteDirectory); await writeFile(localPath,"Local body\n"); await writeFile(remotePath,remoteBody);
  const service = new DocumentService(); service.registerFileAccess("remote-machine",files);
  const config = resolveConfig({profile:"shared-test",runtimeDir:join(root,"runtime"),configDir:join(root,"config")});
  const opens:string[] = [], trashed:string[] = [];
  const daemon = createDaemon({config,service,opener:async url => { opens.push(url); },trashFile:async path => { trashed.push(path); }}); fixtures.push({root,daemon,service}); await daemon.ready;
  const local = await daemon.library.dispatch("document.register",{machineId:service.store.localMachineId,path:localPath}) as {documentId:string;url:string};
  const remote = await daemon.library.dispatch("document.register",{machineId:"remote-machine",path:remotePath}) as {documentId:string;url:string};
  return {root,service,daemon,library:daemon.library,local,remote,localPath,remotePath,remoteDirectory,files,opens,trashed};
}
function request(connection:ReaderConnection,resource:string,body?:unknown,method = body === undefined ? "GET" : "POST") {
  return connection.request(resource,new Request(`https://shared.example/reader/d/test/${resource}`,{
    method,headers:{"content-type":"application/json","x-tether-location-version":"1"},...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }));
}

test("shared registration, UUID operations and browser annotations use one central conversation", async () => {
  const f = await fixture(), before = await stat(f.remotePath);
  const catalog = await f.library.dispatch("folio.list",{view:"all"}) as {files:Array<{id:string;machineId:string}>};
  expect(catalog.files.map(file => file.id).sort()).toEqual([f.local.documentId,f.remote.documentId].sort());
  expect(catalog.files.find(file => file.id === f.remote.documentId)?.machineId).toBe("remote-machine");
  expect(f.remote.url).toBe(`/reader/d/${f.remote.documentId}/`);
  expect(JSON.stringify(f.remote)).not.toContain("127.0.0.1");
  const reader = await f.library.reader.open(f.remote.documentId);
  const bootResponse = await request(reader,"api/bootstrap"); expect(bootResponse.status).toBe(200);
  const boot = await bootResponse.json();
  expect(boot).toMatchObject({sharedReader:true,remoteReader:true,draft:null,document:{body:"Remote body\n",bodyEditable:true,machineId:"remote-machine"}});
  const created = await request(reader,"api/annotations",{type:"comment",actor:"hart",body:"Clarify this",operationId:"browser-comment",expectedBodyRevision:boot.document.bodyRevision,
    anchor:{exact:"Remote",prefix:"",suffix:" body",projectionStart:0,projectionEnd:6,bodyRevision:boot.document.bodyRevision}});
  expect(created.status).toBe(200);
  const pending = await f.library.dispatch("review.pending",{documentId:f.remote.documentId,actor:"assistant",consumer:"remote-agent"}) as {events:Array<{id:string;actor:string;body:string}>;cursor:string};
  expect(pending.events).toHaveLength(1); expect(pending.events[0]).toMatchObject({actor:"hart",body:"Clarify this"});
  await f.library.dispatch("review.reply",{documentId:f.remote.documentId,threadId:pending.events[0]!.id,actor:"assistant",body:"Reviewed",operationId:"agent-reply"});
  const thread = await request(reader,`api/annotations/thread?threadId=${pending.events[0]!.id}`);
  expect((await thread.json()).thread.replies[0]).toMatchObject({actor:"assistant",body:"Reviewed"});
  expect((await f.library.dispatch("review.pending",{documentId:f.local.documentId,actor:"assistant"}) as {events:unknown[]}).events).toHaveLength(0);
  expect((await f.library.dispatch("review.operation",{documentId:f.remote.documentId,operationId:"agent-reply"}) as {outcome:string}).outcome).toBe("applied");
  expect(await readFile(f.remotePath,"utf8")).toBe("Remote body\n"); expect((await stat(f.remotePath)).mtimeMs).toBe(before.mtimeMs);
  await reader.close();
});

test("shared browser saves reach the file machine and reject stale external edits", async () => {
  const f = await fixture(), reader = await f.library.reader.open(f.remote.documentId);
  const initial = await f.library.dispatch("document.read",{documentId:f.remote.documentId}) as {bodyRevision:string};
  const saved = await request(reader,"api/file",{body:"Browser edit\n",expectedBodyRevision:initial.bodyRevision},"PUT");
  expect(saved.status).toBe(200); expect(await readFile(f.remotePath,"utf8")).toBe("Browser edit\n"); expect(f.files.saves).toBe(1);
  const latest = await saved.json(); await writeFile(f.remotePath,"External SSH edit\n");
  const stale = await request(reader,"api/file",{body:"Stale browser edit\n",expectedBodyRevision:latest.bodyRevision},"PUT");
  expect(stale.status).toBe(409); expect((await stale.json()).error.details.outcome).toBe("not_applied");
  expect(await readFile(f.remotePath,"utf8")).toBe("External SSH edit\n"); expect(await readFile(f.localPath,"utf8")).toBe("Local body\n");
  expect(f.service.store.db.query("SELECT COUNT(*) AS count FROM reader_views").get()).toEqual({count:0});
  expect((await request(reader,"api/position",{scroll:50,zoom:110})).status).toBe(200);
  expect(await (await request(reader,"api/draft",{body:"Unsaved",baseRevision:initial.bodyRevision})).json()).toMatchObject({saved:false,persistent:false});
  await reader.close();
});

test("lost save responses verify actual text behind a barrier without replay or refreshed base revision", async () => {
  const f = await fixture(), base = bodyRevision("Remote body\n"), attempted = "Attempted edit\n";
  f.files.loseSaveResponse = true;
  await expect(f.library.dispatch("document.save",{documentId:f.remote.documentId,body:attempted,expectedBodyRevision:base,expectedLocationVersion:1})).rejects.toMatchObject({code:"outcome_unknown"});
  expect(await readFile(f.remotePath,"utf8")).toBe(attempted);
  const matches = await f.library.dispatch("document.verify-save",{documentId:f.remote.documentId,body:attempted,expectedBodyRevision:base,expectedLocationVersion:1}) as Record<string,unknown>;
  expect(matches).toEqual({outcome:"matches_edit",documentId:f.remote.documentId,machineId:"remote-machine",locationVersion:1,path:f.remotePath,bodyRevision:bodyRevision(attempted),conversationRevision:f.service.store.conversationRevision({documentId:f.remote.documentId})});
  expect(matches.outcome).toBe("matches_edit"); expect(f.files.saves).toBe(1); expect(f.files.barriers).toBe(1);
  await writeFile(f.remotePath,"Remote body\n");
  expect((await f.library.dispatch("document.verify-save",{documentId:f.remote.documentId,body:attempted,expectedBodyRevision:base,expectedLocationVersion:1}) as {outcome:string}).outcome).toBe("matches_base");
  await writeFile(f.remotePath,"Another writer\n");
  const reader = await f.library.reader.open(f.remote.documentId);
  expect(await (await request(reader,"api/verify-save",{body:attempted,expectedBodyRevision:base,expectedLocationVersion:1})).json()).toMatchObject({outcome:"diverged"});
  expect(f.files.saves).toBe(1); expect(f.files.barriers).toBe(3);
  f.files.online = false;
  await expect(request(reader,"api/verify-save",{body:attempted,expectedBodyRevision:base,expectedLocationVersion:1})).rejects.toMatchObject({code:"connector_disconnected"});
  expect(await readFile(f.remotePath,"utf8")).toBe("Another writer\n");
  await reader.close();
});

test("offline readers expose bounded historical threads without substituting a body", async () => {
  const f = await fixture();
  const created = await f.library.dispatch("review.comment",{documentId:f.remote.documentId,actor:"human",quote:"Remote",body:"Large review ".repeat(1200),operationId:"offline-comment"}) as {mutation:{eventId:string}};
  f.files.online = false;
  const reader = await f.library.reader.open(f.remote.documentId);
  const bootstrap = await request(reader,"api/bootstrap"); expect(bootstrap.status).toBe(503); expect((await bootstrap.json()).error.code).toBe("connector_disconnected");
  const historyResponse = await request(reader,"api/history?limit=1&maxBytes=2048"); expect(historyResponse.status).toBe(200);
  const history = await historyResponse.json(); expect(history.bodyRevision).toBeNull(); expect(history.anchorContext).toBe("unavailable"); expect(history.threads).toHaveLength(1); expect("body" in history).toBe(false);
  const detail = await f.library.dispatch("document.history",{documentId:f.remote.documentId,threadId:created.mutation.eventId,maxBytes:2048}) as {bodyRevision:null;continuation:string;messages:unknown[]};
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(2048); expect(detail.continuation).toBeString();
  const next = await request(reader,`api/history?threadId=${created.mutation.eventId}&maxBytes=2048&continuation=${detail.continuation}`);
  expect(next.status).toBe(200); expect((await next.json()).messages).not.toEqual(detail.messages);
  expect((await f.library.reader.list!()).find(row => row.id === f.remote.documentId)?.unavailable).toBe(true);
  await reader.close();
});

test("archiving preserves existing readers and reopening restores only after explicit confirmation", async () => {
  const f = await fixture(), reader = await f.library.reader.open(f.remote.documentId), before = await stat(f.remotePath);
  await f.library.dispatch("review.comment",{documentId:f.remote.documentId,actor:"human",quote:"Remote",body:"Keep review",operationId:"archived-comment"});
  await f.library.dispatch("folio.archive",{documentId:f.remote.documentId});
  expect((await request(reader,"api/file")).status).toBe(200);
  const resumed = await f.library.reader.open(f.remote.documentId,{resume:true});
  expect((await request(resumed,"api/file")).status).toBe(200);
  expect(f.service.store.documentById(f.remote.documentId)!.active).toBe(0);
  await resumed.close();
  await expect(f.library.reader.open(f.remote.documentId)).rejects.toMatchObject({code:"restore_required"});
  await expect(f.library.dispatch("document.register",{machineId:"remote-machine",path:f.remotePath})).rejects.toMatchObject({code:"restore_required"});
  expect(f.service.store.listDocuments()).toHaveLength(2); expect(f.service.store.documentById(f.remote.documentId)!.active).toBe(0);
  await f.library.dispatch("document.restore",{documentId:f.remote.documentId});
  const restored = await f.library.reader.open(f.remote.documentId);
  const snapshot = await (await request(restored,"api/file")).json(); expect(snapshot.annotations.events).toHaveLength(1);
  expect(snapshot.annotations.header.documentId).toBe(f.remote.documentId);
  expect((await stat(f.remotePath)).mtimeMs).toBe(before.mtimeMs);
  await reader.close(); await restored.close();
  await f.library.dispatch("folio.delete",{documentId:f.remote.documentId,confirmed:true});
  expect(await f.library.reader.member!(f.remote.documentId)).toBeNull();
  await expect(f.library.reader.open(f.remote.documentId)).rejects.toThrow("no longer exists");
  expect(await readFile(f.remotePath,"utf8")).toBe("Remote body\n");
});

test("relative links and referenced assets stay on the source machine, including archived targets", async () => {
  const f = await fixture("# Remote\n\n![image](../image.png)\n\n[[linked|Next]]\n");
  const linkedPath = join(f.remoteDirectory,"linked.md"); await writeFile(linkedPath,"# Linked\n");
  await writeFile(join(f.root,"image.png"),Buffer.from([137,80,78,71,13,10,26,10,0,0]));
  const reader = await f.library.reader.open(f.remote.documentId), before = await stat(f.remotePath);
  const image = await request(reader,"api/image?src=..%2Fimage.png"); expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/png"); expect(f.files.images).toBe(1);
  await expect(request(reader,"api/image?src=unreferenced.png")).rejects.toMatchObject({code:"image_not_referenced",status:403});
  const link = await request(reader,"api/link?target=linked%23section&format=wikilink"); expect(link.status).toBe(303);
  const linked = f.service.store.documentForPath(linkedPath,"remote-machine")!;
  expect(link.headers.get("location")).toBe(`/reader/d/${linked.id}/#section`);
  expect(f.service.store.documentForPath(linkedPath)).toBeNull();
  await f.library.dispatch("folio.archive",{documentId:linked.id});
  const archivedLink = await request(reader,"api/link?target=linked&format=wikilink");
  expect(archivedLink.status).toBe(303); expect(archivedLink.headers.get("location")).toBe(`/reader/d/${linked.id}/`);
  expect(f.service.store.documentById(linked.id)!.active).toBe(0); expect(f.service.store.listDocuments()).toHaveLength(3);
  const restoredLink = await request(reader,"api/open",{target:"linked",format:"wikilink",restoreArchived:true});
  expect(await restoredLink.json()).toMatchObject({url:`/reader/d/${linked.id}/`,opened:false});
  expect(f.service.store.documentById(linked.id)!.active).toBe(1); expect((await stat(f.remotePath)).mtimeMs).toBe(before.mtimeMs);
  await reader.close();
});

test("relink rejects an existing association and fences an open reader after successful transfer", async () => {
  const f = await fixture(), reader = await f.library.reader.open(f.remote.documentId);
  await expect(f.library.dispatch("document.relink",{documentId:f.remote.documentId,machineId:f.service.store.localMachineId,path:f.localPath})).rejects.toThrow("already has a Tether record");
  expect((await request(reader,"api/file")).status).toBe(200);
  const target = join(f.root,"replacement.md"); await writeFile(target,"Replacement\n");
  await f.library.dispatch("document.relink",{documentId:f.remote.documentId,machineId:f.service.store.localMachineId,path:target});
  const stale = await request(reader,"api/file",{body:"Stale write\n",expectedBodyRevision:bodyRevision("Remote body\n")},"PUT");
  expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("stale_location");
  expect((await f.library.dispatch("document.read",{documentId:f.remote.documentId}) as {body:string}).body).toBe("Replacement\n");
  expect(await readFile(f.remotePath,"utf8")).toBe("Remote body\n"); expect(await readFile(target,"utf8")).toBe("Replacement\n");
  await reader.close();
});

test("local Folio selects machine-qualified identities and refuses native actions on same-path remote files", async () => {
  const f = await fixture(), disk = new TestFileMachine();
  // Both machines expose one spelling; each account resolves it to its own bytes.
  const physical = (location:FileLocation):FileLocation => ({...location,path:f.remotePath});
  const remote:FileAccess = {
    inspect:async path => { expect(path).toBe(f.localPath); return {...await disk.inspect(f.remotePath),path:f.localPath}; },
    bind:location => disk.bind(physical(location)), read:location => disk.read(physical(location)),
    save:(location,input) => disk.save(physical(location),input), image:(location,source) => disk.image(physical(location),source),
    resolveLink:(location,target,format) => disk.resolveLink(physical(location),target,format),
    barrier:location => disk.barrier(physical(location)), fence:location => disk.fence(physical(location)),
  };
  f.service.registerFileAccess("same-path-machine",remote);
  const shadow = await f.library.dispatch("document.register",{machineId:"same-path-machine",path:f.localPath}) as {documentId:string};
  const cliUrls:string[] = [];
  const cli = await runCli(["open",`id:${shadow.documentId}`],{config:f.daemon.config,open:async url => { cliUrls.push(url); }});
  expect(cli.response).toMatchObject({ok:true,data:{path:f.localPath,opened:true}});
  const cliExchange = await fetch(cliUrls[0]!,{redirect:"manual"});
  const cliBoot = await fetch(new URL("api/bootstrap",f.daemon.origin+cliExchange.headers.get("location")!),{headers:{cookie:cliExchange.headers.get("set-cookie")!.split(";",1)[0]!}});
  expect(await cliBoot.json()).toMatchObject({document:{documentId:shadow.documentId,body:"Remote body\n"}});
  expect((await runCli(["folio","pin",`id:${shadow.documentId}`],{config:f.daemon.config})).response).toMatchObject({ok:true});
  expect(f.service.store.documentById(shadow.documentId)!.pinned).toBe(1);
  expect(f.service.store.documentById(f.local.documentId)!.pinned).toBe(0);
  const ticket = await controlRecentsLaunch(f.daemon.config), exchange = await fetch(ticket.url,{redirect:"manual"});
  const location = exchange.headers.get("location")!, cookie = exchange.headers.get("set-cookie")!.split(";",1)[0]!;
  const post = (resource:string,body:unknown) => fetch(new URL(`api/${resource}`,f.daemon.origin+location),{
    method:"POST",headers:{cookie,origin:f.daemon.origin,"content-type":"application/json"},body:JSON.stringify(body),
  });
  const opened = await post("open",{documentId:shadow.documentId}); expect(opened.status).toBe(200);
  expect((await opened.json()).documentId).toBe(shadow.documentId);
  const readerExchange = await fetch(f.opens.at(-1)!,{redirect:"manual"}); expect(readerExchange.status).toBe(302);
  const readerLocation = readerExchange.headers.get("location")!, readerCookie = readerExchange.headers.get("set-cookie")!.split(";",1)[0]!;
  const get = (resource:string) => fetch(new URL(`api/${resource}`,f.daemon.origin+readerLocation),{headers:{cookie:readerCookie}});
  const boot = await (await get("bootstrap")).json();
  expect(boot).toMatchObject({sharedReader:true,draft:null,document:{documentId:shadow.documentId,machineId:"same-path-machine",locationVersion:1,body:"Remote body\n"}});
  for (const action of ["reveal","default","trash"]) {
    const response = await post("action",{documentId:shadow.documentId,action,confirmed:true});
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("local_file_required");
  }
  expect(f.trashed).toHaveLength(0); expect(await readFile(f.localPath,"utf8")).toBe("Local body\n");
  expect(f.service.store.db.query("SELECT 1 FROM reader_views WHERE kind='document'").get()).toBeNull();
  const archived = await post("batch",{documentIds:[shadow.documentId],action:"archive"});
  expect(await archived.json()).toMatchObject({completed:[shadow.documentId],failed:[]});
  expect(f.service.store.documentById(shadow.documentId)!.active).toBe(0); expect(f.service.store.documentById(f.local.documentId)!.active).toBe(1);
  expect((await get("file")).status).toBe(200);
  expect((await post("open",{documentId:shadow.documentId})).status).toBe(409);
  const history = await get("history?maxBytes=2048"); expect(history.status).toBe(200);
  const verify = await fetch(new URL("api/verify-save",f.daemon.origin+readerLocation),{method:"POST",headers:{cookie:readerCookie,origin:f.daemon.origin,"content-type":"application/json","x-tether-location-version":"1"},body:JSON.stringify({body:"Unconfirmed",expectedBodyRevision:bodyRevision("Remote body\n")})});
  expect(await verify.json()).toMatchObject({outcome:"matches_base"}); expect(disk.barriers).toBe(1);
  expect(await readFile(f.localPath,"utf8")).toBe("Local body\n");
});

test("central operation receipts and event fragments remain available while a connector is offline", async () => {
  const f = await fixture();
  const created = await f.library.dispatch("review.comment",{documentId:f.remote.documentId,actor:"human",quote:"Remote",body:"Receipt survives connector loss",operationId:"central-receipt"}) as {mutation:{eventId:string}};
  f.files.online = false;
  expect(await f.library.dispatch("review.operation",{documentId:f.remote.documentId,operationId:"central-receipt"})).toMatchObject({outcome:"applied"});
  expect(await f.library.dispatch("review.event",{documentId:f.remote.documentId,eventId:created.mutation.eventId,maxBytes:2048})).toMatchObject({event:{body:"Receipt survives connector loss"}});
  await expect(f.library.dispatch("document.read",{documentId:crypto.randomUUID()})).rejects.toMatchObject({code:"document_not_found",status:404});
});

test("native reader links require explicit same-origin restoration and preserve the existing target identity", async () => {
  const f = await fixture(), targetPath = join(f.remoteDirectory,"archived.md"); await writeFile(targetPath,"Archived body\n");
  const target = await f.library.dispatch("document.register",{machineId:"remote-machine",path:targetPath}) as {documentId:string};
  await f.library.dispatch("folio.archive",{documentId:target.documentId});
  const ticket = f.daemon.mintTicket(await f.service.openById(f.remote.documentId));
  const exchange = await fetch(ticket.url,{redirect:"manual"}), root = exchange.headers.get("location")!, cookie = exchange.headers.get("set-cookie")!.split(";",1)[0]!;
  const url = new URL("api/link?target=archived&format=wikilink&locationVersion=1&restoreArchived=true",f.daemon.origin+root);
  const prompt = await fetch(url,{headers:{cookie},redirect:"manual"});
  expect(prompt.status).toBe(409); expect(await prompt.text()).toContain("This document has been archived. Restore it?");
  expect(f.service.store.documentById(target.documentId)!.active).toBe(0);
  const body = JSON.stringify({target:"archived",format:"wikilink",restoreArchived:true});
  const wrongOrigin = await fetch(url,{method:"POST",headers:{cookie,origin:"https://unrelated.invalid","content-type":"application/json"},body});
  expect(wrongOrigin.status).toBe(403); expect(f.service.store.documentById(target.documentId)!.active).toBe(0);
  const confirmed = await fetch(url,{method:"POST",headers:{cookie,origin:f.daemon.origin,"content-type":"application/json"},body});
  expect(confirmed.status).toBe(200);
  const launch = await confirmed.json(), reopened = await fetch(launch.url,{redirect:"manual"}); expect(reopened.status).toBe(302);
  expect(f.service.store.documentById(target.documentId)!.active).toBe(1);
  expect(f.service.store.listDocuments()).toHaveLength(3); expect(await readFile(targetPath,"utf8")).toBe("Archived body\n");
});
