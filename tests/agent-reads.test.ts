import { describe, expect, test } from "bun:test";
import { AgentReads } from "../src/documents/agent-reads";
import { bodyRevision, createAnchor, type AnnotationEvent } from "../src/core/index";
import { PrivateStore, REVIEW_CURSOR_LIFETIME_MS } from "../src/storage/private-store";

const path="/tmp/agent-read.md",body="# Heading\n\nA unique passage.\n",revision=bodyRevision(body);
function fixture(text="A question",replyCount=0) {
  const store=new PrivateStore();store.ensureDocument(path);
  const anchor=createAnchor("Heading\nA unique passage.",8,24,revision);
  const events:AnnotationEvent[]=[{type:"comment",id:"comment-1",seq:1,actor:"hart",createdAt:new Date().toISOString(),anchor,body:text}];
  for(let i=0;i<replyCount;i++)events.push({type:"reply",id:`reply-${i}`,seq:i+2,actor:i%2?"assistant":"hart",createdAt:new Date().toISOString(),threadId:"comment-1",body:`Reply ${i}`});
  store.replaceEvents(path,events);return {store,reads:new AgentReads(store)};
}
const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
describe("bounded agent reads",()=>{
  test("pending pages include no unseen sequence in their acknowledgement",()=>{
    const {store,reads}=fixture("Question",8);
    const first=reads.pending(path,body,{limit:2,maxBytes:2048});expect(first.events).toHaveLength(2);expect(first.throughSequence).toBe(2);expect(first.reviewState).toBe("never_reviewed");
    expect(first.continuation).toStartWith("p-");expect(first.cursor).toStartWith("r-");
    store.acknowledge(path,"assistant","assistant",first.cursor);
    const next=reads.pending(path,body,{limit:2,maxBytes:2048,continuation:first.continuation!});expect(next.throughSequence).toBe(6);expect(size(next)).toBeLessThanOrEqual(2048);
    expect(()=>reads.pending(path,body,{actor:"different",continuation:first.continuation!})).toThrow("does not match");
    expect(()=>reads.pending(path,body+"changed",{continuation:first.continuation!})).toThrow("document changed");
    expect(()=>store.acknowledge(path,"assistant","assistant",first.continuation!)).toThrow();store.close();
  });
  test("raw event fragments reconstruct the original without acknowledging it",()=>{
    const text='😀 \\"\n'.repeat(3000),{store,reads}=fixture(text);
    let offset=0,joined="",pages=0;
    do {
      const result=reads.event(path,"comment-1",{maxBytes:2048,offset});
      expect(size(result)).toBeLessThanOrEqual(2048);
      if (!("fragment" in result)) throw new Error("Expected a fragment");
      expect(result.fragment.offset).toBe(joined.length);
      joined+=result.fragment.text;offset=result.fragment.nextOffset??0;
      expect(++pages).toBeLessThan(200);
    }while(offset);
    expect(JSON.parse(joined).body).toBe(text);
    expect(store.acknowledgement(path,"assistant")).toBeNull();store.close();
  });
  test("thread messages paginate and include current edits, suppress deleted replies",()=>{
    const {store,reads}=fixture("Question",4);
    const events=store.events(path);events.push({type:"edit",id:"edit-1",seq:6,actor:"hart",createdAt:new Date().toISOString(),threadId:"comment-1",targetId:"reply-0",body:"Edited"});
    events.push({type:"delete",id:"delete-1",seq:7,actor:"assistant",createdAt:new Date().toISOString(),threadId:"comment-1",targetId:"reply-1"});
    store.db.query("DELETE FROM annotation_events").run();store.replaceEvents(path,events);
    const first=reads.thread(path,body,"comment-1",{limit:2,maxBytes:2048});expect((first.messages[1] as {body:string}).body).toBe("Edited");
    const next=reads.thread(path,body,"comment-1",{limit:2,maxBytes:2048,continuation:first.continuation!});expect(next.messages.map(v=>(v as {id:string}).id)).toEqual(["reply-2","reply-3"]);
    expect(reads.thread(path,body,"comment-1",{beforeSequence:2}).messages).toHaveLength(1);store.close();
  });
  test("thread summaries are sorted by last event and contain no full messages",()=>{
    const {store,reads}=fixture("long ".repeat(1000),3);
    const events=store.events(path);events.push({...events[0]!,id:"comment-2",seq:5} as AnnotationEvent);events.push({type:"resolve",id:"resolve-1",seq:6,actor:"hart",createdAt:new Date().toISOString(),threadId:"comment-1"});
    store.db.query("DELETE FROM annotation_events").run();store.replaceEvents(path,events);
    const result=reads.threads(path,body,{limit:1,maxBytes:2048});expect(result.threads[0]?.id).toBe("comment-1");expect(result.threads[0]?.excerpt.length).toBeLessThanOrEqual(160);expect(size(result)).toBeLessThanOrEqual(2048);
    const next=reads.threads(path,body,{limit:1,maxBytes:2048,continuation:result.continuation!});expect(next.threads[0]?.id).toBe("comment-2");expect(next.continuation).toBeNull();
    expect(reads.threads(path,body,{status:"open"}).threads.map(t=>t.id)).toEqual(["comment-2"]);store.close();
  });
  test("context locates current text and missing revisions have bounded outline fallback",()=>{
    const {store,reads}=fixture();expect(reads.context(path,body,"comment-1").anchorStatus).toBe("located");expect(reads.context(path,"Removed","comment-1").anchorStatus).toBe("orphaned");
    expect(reads.outline(path,body).headings).toEqual([{level:1,title:"Heading",line:1,anchor:"heading"}]);
    const fallback=reads.diff(path,("# title\n".repeat(1000)),"sha256:"+"0".repeat(64),{maxBytes:2048});expect(fallback.status).toBe("revision_unavailable");expect(size(fallback)).toBeLessThanOrEqual(2048);store.close();
  });
  test("outline anchors follow GitHub duplicates, formatting and Unicode across pages",()=>{
    const {store,reads}=fixture();
    const source='---\ntitle: Test\n---\n# Hello, **world**!\n# Hello, world!\n# Hello, world!-1\n# Café 中文\n';
    const headings=reads.outline(path,source).headings;
    expect(headings.map(h=>h.anchor)).toEqual(['hello-world','hello-world-1','hello-world-1-1','café-中文']);
    expect(headings[0]?.line).toBe(4);
    expect(reads.outline(path,source,{offset:2}).headings).toEqual(headings.slice(2));
    store.close();
  });
  test("observed revisions support bounded change recovery without persistent history",()=>{
    const {store,reads}=fixture();reads.pending(path,body);
    const changed=reads.diff(path,body.replace("unique","different"),revision,{maxBytes:2048});expect(changed.status).toBe("changed");expect("changes" in changed && changed.changes?.[0]).toMatchObject({before:"unique",after:"different",beforeOmitted:0,afterOmitted:0});
    const oversized=reads.diff(path,"X".repeat(10000),revision,{maxBytes:2048});expect(size(oversized)).toBeLessThanOrEqual(2048);expect("changes" in oversized && oversized.changes?.[0]?.afterOmitted).toBeGreaterThan(0);
    expect(new AgentReads(store).diff(path,"new",revision).status).toBe("revision_unavailable");store.close();
  });
  test("same-sequence observations cannot regress reviewed body even when timestamps are equal",()=>{
    const {store}=fixture();const now=Date.now();const old=store.observe(path,"assistant",1,"old",now),newer=store.observe(path,"assistant",1,"new",now);
    store.acknowledge(path,"assistant","assistant",newer.cursor,now);expect(()=>store.acknowledge(path,"assistant","assistant",old.cursor,now)).toThrow("older observation");
    expect(store.acknowledgement(path,"assistant")?.bodyRevision).toBe("new");store.close();
  });
  test("cursor expiry is explicit; missing receipts don't claim nonapplication",()=>{
    const {store}=fixture();const now=Date.now(),old=store.observe(path,"assistant",1,revision,now-REVIEW_CURSOR_LIFETIME_MS-1);
    expect(()=>store.observation(path,"assistant",old.cursor,now)).toThrow("expired");expect(store.lookupMutation(path,"unknown").outcome).toBe("outcome_unknown");store.observe(path,"assistant",1,revision,now);
    expect(store.db.query("SELECT COUNT(*) AS count FROM review_observations").get()).toEqual({count:1});store.close();
  });
});

describe("pending index", () => {
  test("large bodies become bounded references while raw events remain lossless", () => {
    const text = '😀 \\"\n'.repeat(3000);
    const { store, reads } = fixture(text);
    const page = reads.pending(path, body, { maxBytes: 2048 });
    expect(page.events).toEqual([{ id: "comment-1", seq: 1, type: "comment", actor: "hart", threadId: "comment-1" }]);
    expect(page.continuation).toBeNull();
    expect(page.throughSequence).toBe(1);
    expect(size(page)).toBeLessThanOrEqual(2048);
    expect(store.acknowledgement(path, "assistant")).toBeNull();
    expect(reads.event(path, "comment-1", { maxBytes: 2048 })).toHaveProperty("fragment");
    expect(store.events(path)[0]).toHaveProperty("body", text);
    store.close();
  });

  test("every change kind remains discoverable, including deleted roots and historical edits", () => {
    const { store, reads } = fixture("Original", 1);
    const events = store.events(path);
    const stamp = { actor: "hart", createdAt: new Date().toISOString(), threadId: "comment-1" };
    events.push({ ...stamp, type: "edit", id: "edit", seq: 3, targetId: "reply-0", body: "Revised" });
    events.push({ ...stamp, type: "delete", id: "delete-reply", seq: 4, targetId: "reply-0" });
    events.push({ ...stamp, type: "resolve", id: "resolve", seq: 5 });
    events.push({ ...stamp, type: "reopen", id: "reopen", seq: 6 });
    events.push({ ...stamp, type: "delete", id: "delete-root", seq: 7, targetId: "comment-1" });
    store.db.query("DELETE FROM annotation_events").run(); store.replaceEvents(path, events);
    const page = reads.pending(path, body);
    expect(page.events.map((event: any) => event.type)).toEqual(["comment", "reply", "edit", "delete", "resolve", "reopen", "delete"]);
    expect(page.events[2]).toMatchObject({ id: "edit", threadId: "comment-1", targetId: "reply-0" });
    expect(page.events[6]).toMatchObject({ targetId: "comment-1" });
    expect(JSON.stringify(page.events)).not.toContain("Revised");
    expect(reads.thread(path, body, "comment-1").messages).toEqual([]);
    expect(reads.event(path, "edit")).toMatchObject({ event: { body: "Revised" } });
    expect(reads.event(path, "reply-0")).toMatchObject({ event: { body: "Reply 0" } });
    store.close();
  });

  test("index continuations bind kind, actor, consumer, body and snapshot", () => {
    const { store, reads } = fixture("Question", 4);
    const first = reads.pending(path, body, { consumer: "reviewer", limit: 1 });
    const continuation = first.continuation!;
    expect(first.throughSequence).toBe(1);
    for (const options of [{}, { consumer: "reviewer", actor: "other" }]) {
      expect(() => reads.pending(path, body, { ...options, continuation })).toThrow("does not match");
    }
    expect(() => reads.pending(path, body + " changed", { consumer: "reviewer", continuation })).toThrow("document changed");
    // Old raw-event continuations must never reuse their fragment offsets as index offsets.
    const legacy = reads.pending(path, body, { limit: 1 }).continuation!;
    const row = store.db.query("SELECT payload_json FROM agent_continuations WHERE cursor=?").get(legacy) as { payload_json: string };
    store.db.query("UPDATE agent_continuations SET payload_json=? WHERE cursor=?").run(JSON.stringify({ ...JSON.parse(row.payload_json), kind: "pending", fragmentOffset: 10 }), legacy);
    expect(() => reads.pending(path, body, { continuation: legacy })).toThrow("does not match");
    const events = store.events(path);
    events.push({ type: "reply", id: "late", seq: 6, actor: "hart", createdAt: new Date().toISOString(), threadId: "comment-1", body: "Late" });
    store.db.query("DELETE FROM annotation_events").run(); store.replaceEvents(path, events);
    const last = reads.pending(path, body, { consumer: "reviewer", continuation });
    expect(last.events.map((event: any) => event.seq)).toEqual([2, 4]);
    expect(last.throughSequence).toBe(5);
    store.acknowledge(path, "reviewer", "assistant", last.cursor);
    expect(reads.pending(path, body, { consumer: "reviewer" }).events).toMatchObject([{ id: "late" }]);
    expect(reads.pending(path, body).events).toHaveLength(4);
    store.close();
  });

  test("oversized index entries fragment without truncation or premature acknowledgement", () => {
    const { store, reads } = fixture();
    const events = store.events(path); events[0]!.actor = '😀"'.repeat(3000);
    store.db.query("DELETE FROM annotation_events").run(); store.replaceEvents(path, events);
    let continuation: string | undefined, joined = "", pages = 0;
    do {
      const page = reads.pending(path, body, { maxBytes: 2048, continuation });
      expect(size(page)).toBeLessThanOrEqual(2048);
      const fragment = (page.events[0] as any).fragment;
      expect(fragment.offset).toBe(joined.length);
      joined += fragment.text;
      continuation = page.continuation ?? undefined;
      expect(page.throughSequence).toBe(continuation ? 0 : 1);
      expect(++pages).toBeLessThan(200);
    } while (continuation);
    expect(JSON.parse(joined).actor).toBe(events[0]!.actor);
    store.close();
  });

  test("empty indexes retain the revision needed to inspect body-only changes", () => {
    const store = new PrivateStore(); store.ensureDocument(path); const reads = new AgentReads(store);
    const first = reads.pending(path, body);
    expect(first).toMatchObject({ events: [], reviewState: "never_reviewed", acknowledgedBodyRevision: null });
    store.acknowledge(path, "assistant", "assistant", first.cursor);
    expect(reads.pending(path, body)).toMatchObject({ events: [], reviewState: "current", acknowledgedBodyRevision: revision });
    const changed = reads.pending(path, body + "More text");
    expect(changed).toMatchObject({ events: [], reviewState: "changed", acknowledgedBodyRevision: revision });
    expect(reads.diff(path, body + "More text", changed.acknowledgedBodyRevision!)).toMatchObject({ status: "changed" });
    expect(store.acknowledgement(path, "assistant")?.bodyRevision).toBe(revision);
    store.close();
  });
});

test("thread reads budget emitted metadata, not unused escaped summary text", () => {
  const { store, reads } = fixture("\u0001".repeat(160));
  const events = store.events(path); events[0]!.actor = "\u0001".repeat(128);
  store.db.query("DELETE FROM annotation_events").run(); store.replaceEvents(path, events);
  expect(() => reads.threads(path, body)).toThrow("Thread metadata exceeds");
  let continuation: string | undefined, joined = "";
  do {
    const page = reads.thread(path, body, "comment-1", { maxBytes: 2048, continuation });
    expect(size(page)).toBeLessThanOrEqual(2048);
    expect(page.thread).toEqual({ id: "comment-1", status: "open", sequence: 1 });
    const fragment = (page.messages[0] as any).fragment;
    expect(fragment.offset).toBe(joined.length); joined += fragment.text;
    continuation = page.continuation ?? undefined;
  } while (continuation);
  expect(JSON.parse(joined)).toMatchObject({ body: "\u0001".repeat(160), actor: events[0]!.actor });
  store.close();
});
