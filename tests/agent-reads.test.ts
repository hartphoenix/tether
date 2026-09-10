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
  test("oversized JSON events are losslessly fragmented without acknowledging omitted content",()=>{
    const text='😀 \\"\n'.repeat(3000),{store,reads}=fixture(text);
    let continuation:string|undefined,joined="",lastCursor="",pages=0;
    do {
      const result=reads.pending(path,body,{maxBytes:2048,continuation});expect(size(result)).toBeLessThanOrEqual(2048);
      const item=result.events[0] as {fragment:{text:string;nextOffset:number|null}};
      joined+=item.fragment.text;lastCursor=result.cursor;continuation=result.continuation??undefined;pages++;
      expect(result.throughSequence).toBe(continuation?0:1);
      expect(pages).toBeLessThan(200);
    }while(continuation);
    expect(JSON.parse(joined).body).toBe(text);store.acknowledge(path,"assistant","assistant",lastCursor);expect(reads.pending(path,body).events).toHaveLength(0);store.close();
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
    expect(reads.outline(path,body).headings).toEqual([{level:1,title:"Heading",line:1}]);
    const fallback=reads.diff(path,("# title\n".repeat(1000)),"sha256:"+"0".repeat(64),{maxBytes:2048});expect(fallback.status).toBe("revision_unavailable");expect(size(fallback)).toBeLessThanOrEqual(2048);store.close();
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
