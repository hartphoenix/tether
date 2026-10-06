import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, realpath, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision } from "../src/core/index";
import { DocumentService, FileAccessError, LocalFileAccess, PrivateStore, type FileLocation } from "../src/documents/index";
import { RecentsRegistry } from "../src/recents/registry";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
  const root = await mkdtemp("/tmp/tether-machines-"); roots.push(root);
  const path = join(root,"doc.md"); await writeFile(path,"Body\n");
  return {root,path:await realpath(path)};
}
function anchor() { return {exact:"Body",prefix:"",suffix:"\n",projectionStart:0,projectionEnd:4,bodyRevision:bodyRevision("Body\n")}; }

test("legacy location migration preserves UUID, review receipts, acknowledgement and archive state", async () => {
  const {root,path} = await fixture(), database = join(root,"private.sqlite");
  let store = new PrivateStore(database);
  const record = store.ensureDocument(path), id = record.id;
  store.appendEvent({path,event:{type:"comment",id:"comment",seq:1,actor:"human",createdAt:new Date().toISOString(),body:"Keep me",anchor:anchor()},operationId:"op",payloadHash:"hash"});
  const observed = store.observe(path,"agent",1,bodyRevision("Body\n"));
  store.acknowledge(path,"agent","assistant",observed.cursor);
  store.db.query("UPDATE documents SET active=0,pinned=1,archived_at=10 WHERE id=?").run(id);
  store.close();
  const legacy = new Database(database);
  legacy.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE old_documents(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,title TEXT,added_at INTEGER NOT NULL,opened_at INTEGER NOT NULL,
      conversation_at INTEGER,body_mtime_ms REAL,created_at_ms REAL,active INTEGER NOT NULL DEFAULT 1,pinned INTEGER NOT NULL DEFAULT 0,archived_at INTEGER,expires_at INTEGER);
    INSERT INTO old_documents SELECT id,path,title,added_at,opened_at,conversation_at,body_mtime_ms,created_at_ms,active,pinned,archived_at,expires_at FROM documents;
    DROP TABLE documents; ALTER TABLE old_documents RENAME TO documents;
    DELETE FROM settings WHERE key='local_machine_id';`);
  legacy.close();
  store = new PrivateStore(database);
  expect(store.documentForPath(path)).toMatchObject({id,active:0,pinned:1,location_version:1,machine_id:store.localMachineId});
  expect(store.events({documentId:id})).toHaveLength(1);
  expect(store.lookupMutation({documentId:id},"op").outcome).toBe("applied");
  expect(store.acknowledgement({documentId:id},"agent")).toMatchObject({cursor:observed.cursor,throughSeq:1});
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect((await readdir(root)).some(name => name.includes(".before-machines-"))).toBe(true);
  const machineId = store.localMachineId; store.close();
  store = new PrivateStore(database); expect(store.localMachineId).toBe(machineId); store.close();
});

test("identical paths on different machines have separate reviews and ID-scoped Folio mutations", async () => {
  const {root,path} = await fixture(), service = new DocumentService();
  service.registerFileAccess("remote",new LocalFileAccess());
  const local = await service.open(path), remote = await service.openLocation("remote",path);
  expect(remote.documentId).not.toBe(local.documentId);
  await service.appendComment({session:remote,actor:"human",body:"Remote review",anchor:anchor(),expectedBodyRevision:bodyRevision("Body\n")});
  expect((await service.read(local)).annotations.events).toHaveLength(0);
  expect((await service.read(remote)).annotations.events).toHaveLength(1);
  const registry = new RecentsRegistry({path:join(root,"recents.json"),database:service.store.db});
  await registry.archive([{documentId:remote.documentId}]);
  expect(service.store.documentById(local.documentId)!.active).toBe(1);
  expect(service.store.documentById(remote.documentId)!.active).toBe(0);
  expect((await registry.listFolio({view:"archive"}))[0]).toMatchObject({id:remote.documentId,machineId:"remote",missing:false,fileIssue:{code:"connector_disconnected"}});
  await expect(service.openLocation("remote",path)).rejects.toMatchObject({code:"restore_required"});
  expect(service.store.listDocuments()).toHaveLength(2);
  expect((await service.read(remote)).body).toBe("Body\n");
  expect((await service.openById(remote.documentId,{restoreArchived:true})).documentId).toBe(remote.documentId);
  service.store.close();
});

test("relink fences stale sessions and preserves central reviews when the original file is missing", async () => {
  const {root,path} = await fixture(), service = new DocumentService();
  const session = await service.open(path), target = join(root,"replacement.md");
  await service.appendComment({session,actor:"human",body:"Keep",anchor:anchor(),expectedBodyRevision:bodyRevision("Body\n")});
  await writeFile(target,"Replacement\n"); await unlink(path);
  const linked = await service.relink(session.documentId,service.store.localMachineId,target);
  expect(linked.documentId).toBe(session.documentId);
  expect(linked.locationVersion).toBeGreaterThan(session.locationVersion);
  expect((await service.read(linked)).annotations.events).toHaveLength(1);
  await expect(service.saveBody(session,"Wrong\n",bodyRevision("Body\n"))).rejects.toMatchObject({code:"stale_location"});
  expect(await readFile(target,"utf8")).toBe("Replacement\n");
  service.store.close();
});

test("registered remote history remains readable without current file bytes", async () => {
  const {path} = await fixture(), store = new PrivateStore(), remote = store.ensureLocation("offline",path);
  store.appendEvent({path:{documentId:remote.id},event:{type:"comment",id:"comment",seq:1,actor:"human",createdAt:new Date().toISOString(),body:"History",anchor:anchor()},operationId:"op",payloadHash:"hash"});
  const service = new DocumentService({store}), session = await service.openById(remote.id);
  await expect(service.read(session)).rejects.toMatchObject({code:"connector_disconnected"});
  const history = service.history(remote.id);
  expect(history).toMatchObject({documentId:remote.id,bodyRevision:null,anchorContext:"unavailable"});
  expect("threads" in history && history.threads[0]!.excerpt).toBe("History");
  expect("body" in history).toBe(false);
  store.close();
});

test("file fences are idempotent after restart and prevent superseded location binding", async () => {
  const {path} = await fixture(), files = new LocalFileAccess(), location = {documentId:"doc",machineId:"machine",path,version:1};
  await files.fence(location); await files.fence(location);
  await expect(files.bind(location)).rejects.toMatchObject({code:"stale_location"});
  await files.bind({...location,version:2});
  expect((await files.read({...location,version:2})).source).toBe("Body\n");
});

test("lost fence acknowledgement preserves a usable original association across service restart", async () => {
  const {root,path} = await fixture(), target = join(root,"next.md"), store = new PrivateStore();
  await writeFile(target,"Next\n");
  class InterruptedFence extends LocalFileAccess {
    override async fence(location: FileLocation) {
      await super.fence(location);
      throw new FileAccessError("connector_disconnected","Disconnected after fencing.");
    }
  }
  const files = new InterruptedFence(), service = new DocumentService({store});
  service.registerFileAccess("remote",files);
  const original = await service.openLocation("remote",path);
  await expect(service.relink(original.documentId,"remote",target)).rejects.toMatchObject({code:"connector_disconnected",details:{locationChanged:false,reopenRequired:true}});
  const record = store.documentById(original.documentId)!;
  expect(record.path).toBe(path);
  expect(record.location_version).toBeGreaterThan(original.locationVersion);
  const restarted = new DocumentService({store}); restarted.registerFileAccess("remote",files);
  expect((await restarted.read(await restarted.openById(original.documentId))).body).toBe("Body\n");
  expect(await readFile(target,"utf8")).toBe("Next\n");
  store.close();
});

test("service relocation registers local files under the selected machine rather than old schema defaults", async () => {
  const {root,path} = await fixture(), database = join(root,"private.sqlite");
  let store = new PrivateStore(database);
  const original = store.ensureDocument(path), newMachineId = crypto.randomUUID();
  store.db.query("UPDATE settings SET value=? WHERE key='local_machine_id'").run(newMachineId); store.close();
  store = new PrivateStore(database);
  const registry = new RecentsRegistry({path:join(root,"recents.json"),database:store.db});
  await registry.add(path);
  expect(store.documentForPath(path)?.machine_id).toBe(newMachineId);
  expect(store.documentById(original.id)?.machine_id).toBe(original.machine_id);
  expect(store.listDocuments()).toHaveLength(2);
  store.close();
});

test("body-free history retains bounded pagination for large review messages", async () => {
  const {path} = await fixture(), service = new DocumentService(), session = await service.open(path);
  const snapshot = await service.appendComment({session,actor:"human",body:"Review ".repeat(1200),anchor:anchor(),expectedBodyRevision:bodyRevision("Body\n")});
  const threadId = (snapshot.annotations.events[0] as {id:string}).id;
  await unlink(path);
  const first = service.history(session.documentId,{threadId,maxBytes:2048});
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2048);
  expect(first.continuation).toBeString();
  const second = service.history(session.documentId,{threadId,maxBytes:2048,continuation:first.continuation!});
  expect(second.bodyRevision).toBeNull();
  expect("messages" in second && second.messages).not.toEqual("messages" in first && first.messages);
  service.store.close();
});

test("failed remote registration does not leave an unverified catalog record", async () => {
  const {path} = await fixture(), service = new DocumentService();
  class RefusedBinding extends LocalFileAccess { override async bind() { throw new FileAccessError("connector_disconnected","Disconnected before binding."); } }
  service.registerFileAccess("remote",new RefusedBinding());
  await expect(service.openLocation("remote",path)).rejects.toMatchObject({code:"connector_disconnected"});
  expect(service.store.listDocuments()).toHaveLength(0);
  service.store.close();
});

test("relinking an archived document preserves archive state for unchanged and changed locations", async () => {
  const {root,path} = await fixture(), service = new DocumentService(), session = await service.open(path);
  await service.appendComment({session,actor:"human",body:"Preserve archived review",anchor:anchor(),expectedBodyRevision:bodyRevision("Body\n")});
  const registry = new RecentsRegistry({path:join(root,"recents.json"),database:service.store.db});
  await registry.archive([{documentId:session.documentId}]);
  const archived = service.store.documentById(session.documentId)!;
  const unchanged = await service.relink(session.documentId,session.machineId,path);
  expect(unchanged).toMatchObject({documentId:session.documentId,locationVersion:session.locationVersion,path});
  expect(service.store.documentById(session.documentId)).toMatchObject({active:0,archived_at:archived.archived_at,expires_at:archived.expires_at});
  expect((await service.read(unchanged)).annotations.events).toHaveLength(1);
  const target = join(root,"relinked.md"); await writeFile(target,"Relinked body\n");
  const changed = await service.relink(session.documentId,session.machineId,target);
  expect(changed).toMatchObject({documentId:session.documentId,path:await realpath(target)});
  expect(changed.locationVersion).toBeGreaterThan(session.locationVersion);
  expect(service.store.documentById(session.documentId)).toMatchObject({active:0,archived_at:archived.archived_at,expires_at:archived.expires_at});
  expect((await service.read(changed)).annotations.events).toHaveLength(1);
  await expect(service.openById(session.documentId)).rejects.toMatchObject({code:"restore_required"});
  expect(await readFile(path,"utf8")).toBe("Body\n"); expect(await readFile(target,"utf8")).toBe("Relinked body\n");
  service.store.close();
});
