import { unified } from "unified";
import remarkParse from "remark-parse";
import { bodyRevision } from "../core/index";
import { markdownProjection } from "../server/quote-anchor";
import { PrivateStore, PrivateStoreConflictError, PrivateStoreDocumentNotFoundError, REVIEW_CURSOR_LIFETIME_MS } from "../storage/private-store";
export type AgentPageOptions = {
    limit?: number;
    maxBytes?: number;
    continuation?: string;
    beforeSequence?: number;
};
type PageState = {
    kind: string;
    revision: string;
    snapshot: number;
    after: number;
    fragmentOffset: number;
    identity: string;
};
type EventRef = {
    id: string;
    seq: number;
};
type Fragment = {
    seq: number;
    fragment: {
        encoding: "json";
        offset: number;
        nextOffset: number | null;
        text: string;
    };
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function fail(message: string): never { throw Object.assign(new Error(message), { code: message === "Annotation thread not found." ? "thread_not_found" : "invalid_request", status: message === "Annotation thread not found." ? 404 : 400 }); }
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
    const number = value ?? fallback;
    if (!Number.isSafeInteger(number) || number < min || number > max)
        fail(`Expected an integer from ${min} to ${max}.`);
    return number;
}
function budget(options: {
    maxBytes?: number;
}): number { return bound(options.maxBytes, 16384, 2048, 65536); }
/** Prefix by UTF-16 offset without splitting surrogate pairs. Offsets are returned, never inferred by callers. */
function fitText(text: string, maxBytes: number): string {
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (bytes(text.slice(0, mid)) <= maxBytes)
            lo = mid;
        else
            hi = mid - 1;
    }
    if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1]!))
        lo--;
    return text.slice(0, lo);
}
/** Agent DTOs deliberately omit the browser snapshot and historic aliases. All reads require an already authorized path/body. */
export class AgentReads {
    private readonly revisions = new Map<string, string>();
    private revisionBytes = 0;
    constructor(readonly store: PrivateStore) { }
    forget(path: string): void {
        const doc = this.store.documentForPath(path);
        if (!doc)
            return;
        for (const [key, value] of this.revisions)
            if (key.startsWith(`${doc.id}:`)) {
                this.revisions.delete(key);
                this.revisionBytes -= Buffer.byteLength(value);
            }
    }
    private document(path: string) { const doc = this.store.documentForPath(path); if (!doc)
        throw new PrivateStoreDocumentNotFoundError(); return doc; }
    /** Small, process-local recovery cache; never a persistent Markdown history. */
    private remember(path: string, body: string): string {
        const revision = bodyRevision(body), key = `${this.document(path).id}:${revision}`, size = Buffer.byteLength(body);
        if (size > 2 * 1024 * 1024)
            return revision;
        if (this.revisions.has(key))
            this.revisions.delete(key);
        else
            this.revisionBytes += size;
        this.revisions.set(key, body);
        while (this.revisionBytes > 32 * 1024 * 1024 || this.revisions.size > 64) {
            const first = this.revisions.keys().next().value!;
            this.revisionBytes -= Buffer.byteLength(this.revisions.get(first)!);
            this.revisions.delete(first);
        }
        return revision;
    }
    private latest(documentId: string): number { return (this.store.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM annotation_events WHERE document_id=?").get(documentId) as {
        seq: number;
    }).seq; }
    private state(path: string, body: string, kind: string, identity: string, options: AgentPageOptions, after: number): PageState {
        const doc = this.document(path), revision = this.remember(path, body);
        if (!options.continuation)
            return { kind, identity, revision, snapshot: this.latest(doc.id), after, fragmentOffset: 0 };
        const row = this.store.db.query("SELECT payload_json,created_at FROM agent_continuations WHERE cursor=? AND document_id=?").get(options.continuation, doc.id) as {
            payload_json: string;
            created_at: number;
        } | null;
        if (!row || row.created_at < Date.now() - REVIEW_CURSOR_LIFETIME_MS)
            throw new PrivateStoreConflictError("The continuation is invalid or expired; restart this read.");
        const state = JSON.parse(row.payload_json) as PageState;
        if (state.kind !== kind || state.identity !== identity || state.revision !== revision)
            throw new PrivateStoreConflictError("The continuation does not match this read or the document changed; restart this read.");
        return state;
    }
    private continuation(path: string, state: PageState): string {
        const cursor = `p-${crypto.randomUUID()}`;
        this.store.db.query("DELETE FROM agent_continuations WHERE created_at < ?").run(Date.now() - REVIEW_CURSOR_LIFETIME_MS);
        this.store.db.query("INSERT INTO agent_continuations VALUES(?,?,?,?)").run(cursor, this.document(path).id, JSON.stringify(state), Date.now());
        return cursor;
    }
    private payload(documentId: string, id: string): string {
        const row = this.store.db.query("SELECT payload_json FROM annotation_events WHERE document_id=? AND id=?").get(documentId, id) as {
            payload_json: string;
        } | null;
        if (!row)
            fail("Annotation event not found.");
        return row.payload_json;
    }
    private fragment(ref: EventRef, json: string, offset: number, available: number): Fragment {
        const text = fitText(json.slice(offset), available - 180);
        if (!text)
            fail("The response budget is too small for this item.");
        const next = offset + text.length;
        return { seq: ref.seq, fragment: { encoding: "json", offset, nextOffset: next < json.length ? next : null, text } };
    }
    pending(path: string, body: string, options: AgentPageOptions & {
        actor?: string;
        consumer?: string;
    } = {}) {
        const maxBytes = budget(options), limit = bound(options.limit, 50, 1, 200), actor = options.actor ?? "assistant", consumer = options.consumer ?? actor;
        const doc = this.document(path), acknowledgement = this.store.acknowledgement(path, consumer) as {
            throughSeq: number;
            bodyRevision: string;
        } | null;
        const state = this.state(path, body, "pending", JSON.stringify([actor, consumer]), options, acknowledgement?.throughSeq ?? 0);
        const refs = this.store.db.query("SELECT id,seq FROM annotation_events WHERE document_id=? AND seq>? AND seq<=? AND type!='ack' AND actor!=? ORDER BY seq LIMIT ?").all(doc.id, state.after, state.snapshot, actor, limit + 1) as EventRef[];
        const events: unknown[] = [];
        const base = { documentId: doc.id, bodyRevision: state.revision, maxSequence: state.snapshot, acknowledgedBodyRevision: acknowledgement?.bodyRevision ?? null,
            reviewState: !acknowledgement ? "never_reviewed" : acknowledgement.bodyRevision === state.revision ? "current" : "changed",
            bodyChangedSinceAck: !acknowledgement || acknowledgement.bodyRevision !== state.revision, maxBytes };
        let available = maxBytes - bytes(base) - 400, after = state.after, fragmentOffset = state.fragmentOffset, more = false;
        for (const ref of refs) {
            if (events.length >= limit) {
                more = true;
                break;
            }
            const json = this.payload(doc.id, ref.id), event = JSON.parse(json) as unknown;
            if (!fragmentOffset && bytes(event) + 1 <= available) {
                events.push(event);
                available -= bytes(event) + 1;
                after = ref.seq;
                continue;
            }
            if (events.length) {
                more = true;
                break;
            }
            const fragment = this.fragment(ref, json, fragmentOffset, available);
            events.push(fragment);
            fragmentOffset = fragment.fragment.nextOffset ?? 0;
            if (!fragmentOffset)
                after = ref.seq;
            more = fragmentOffset > 0 || refs.length > 1;
            break;
        }
        if (!more)
            after = state.snapshot;
        const cursor = this.store.observe(path, consumer, after, state.revision).cursor;
        const continuation = more ? this.continuation(path, { ...state, after, fragmentOffset }) : null;
        return { ...base, events, cursor, throughSequence: after, continuation, expiresInSeconds: REVIEW_CURSOR_LIFETIME_MS / 1000 };
    }
    private summary(documentId: string, id: string, snapshot: number) {
        const result = this.store.db.query(`SELECT c.id,substr(c.actor,1,128) AS actor,c.created_at AS createdAt,
      substr(COALESCE((SELECT e.body FROM annotation_events e WHERE e.document_id=c.document_id AND e.target_id=c.id AND e.type='edit' AND e.seq<=? ORDER BY e.seq DESC LIMIT 1),c.body),1,160) AS excerpt,
      CASE COALESCE((SELECT s.type FROM annotation_events s WHERE s.document_id=c.document_id AND s.thread_id=c.id AND s.type IN ('resolve','reopen') AND s.seq<=? ORDER BY s.seq DESC LIMIT 1),'reopen') WHEN 'resolve' THEN 'resolved' ELSE 'open' END AS status,
      (SELECT MAX(e.seq) FROM annotation_events e WHERE e.document_id=c.document_id AND (e.thread_id=c.id OR e.id=c.id) AND e.seq<=?) AS sequence,
      (SELECT COUNT(*) FROM annotation_events r WHERE r.document_id=c.document_id AND r.thread_id=c.id AND r.type='reply' AND r.seq<=? AND NOT EXISTS(SELECT 1 FROM annotation_events d WHERE d.document_id=c.document_id AND d.target_id=r.id AND d.type='delete' AND d.seq<=?)) AS replyCount
      FROM annotation_events c WHERE c.document_id=? AND c.id=? AND c.type='comment'`).get(snapshot, snapshot, snapshot, snapshot, snapshot, documentId, id) as {
            id: string;
            actor: string;
            createdAt: string;
            excerpt: string;
            status: string;
            sequence: number;
            replyCount: number;
        } | null;
        if (result && bytes(result) > 1200)
            throw Object.assign(new Error("Thread metadata exceeds the response budget. Retrieve its root event with event."), { code: "item_too_large", eventId: id });
        return result;
    }
    threads(path: string, body: string, options: AgentPageOptions & {
        status?: "open" | "resolved";
    } = {}) {
        const maxBytes = budget(options), limit = bound(options.limit, 50, 1, 200), doc = this.document(path);
        const before = bound(options.beforeSequence, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
        const state = this.state(path, body, "threads", JSON.stringify([options.status ?? "all", before]), options, before);
        const threads: NonNullable<ReturnType<AgentReads["summary"]>>[] = [];
        let after = state.after, more = false, available = maxBytes - 600;
        // Keyset by latest event, stable within the captured sequence snapshot. SQL returns only IDs.
        const refs = this.store.db.query(`SELECT * FROM (SELECT c.id, (SELECT MAX(e.seq) FROM annotation_events e WHERE e.document_id=c.document_id AND (e.thread_id=c.id OR e.id=c.id) AND e.seq<=?) AS latest FROM annotation_events c
      WHERE c.document_id=? AND c.type='comment' AND c.seq<=? AND NOT EXISTS(SELECT 1 FROM annotation_events d WHERE d.document_id=c.document_id AND d.target_id=c.id AND d.type='delete' AND d.seq<=?)) WHERE latest<? ORDER BY latest DESC LIMIT ?`).all(state.snapshot, doc.id, state.snapshot, state.snapshot, state.after, 201) as {
            id: string;
            latest: number;
        }[];
        for (const ref of refs) {
            const summary = this.summary(doc.id, ref.id, state.snapshot)!;
            if (options.status && summary.status !== options.status) {
                after = ref.latest;
                continue;
            }
            if (threads.length >= limit || bytes(summary) + 1 > available) {
                more = true;
                break;
            }
            threads.push(summary);
            available -= bytes(summary) + 1;
            after = ref.latest;
        }
        if (refs.length === 201)
            more = true;
        return { documentId: doc.id, bodyRevision: state.revision, maxSequence: state.snapshot, threads, maxBytes, continuation: more ? this.continuation(path, { ...state, after }) : null };
    }
    thread(path: string, body: string, threadId: string, options: AgentPageOptions = {}) {
        const maxBytes = budget(options), limit = bound(options.limit, 50, 1, 200), doc = this.document(path);
        const before = bound(options.beforeSequence, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
        const state = this.state(path, body, "thread", JSON.stringify([threadId, before]), options, 0);
        const summary = this.summary(doc.id, threadId, state.snapshot);
        if (!summary)
            fail("Annotation thread not found.");
        const refs = this.store.db.query(`SELECT m.id,m.seq FROM annotation_events m WHERE m.document_id=? AND (m.id=? OR m.thread_id=?) AND m.type IN ('comment','reply') AND m.seq>? AND m.seq<? AND m.seq<=?
      AND NOT EXISTS(SELECT 1 FROM annotation_events d WHERE d.document_id=m.document_id AND d.target_id=m.id AND d.type='delete' AND d.seq<=?) ORDER BY m.seq LIMIT ?`).all(doc.id, threadId, threadId, state.after, before, state.snapshot, state.snapshot, limit + 1) as EventRef[];
        const messages: unknown[] = [];
        let available = maxBytes - bytes(summary) - 650, after = state.after, fragmentOffset = state.fragmentOffset, more = false;
        for (const ref of refs) {
            if (messages.length >= limit) {
                more = true;
                break;
            }
            const row = this.store.db.query(`SELECT m.id,m.seq,m.type,m.actor,m.created_at AS createdAt,COALESCE((SELECT e.body FROM annotation_events e WHERE e.document_id=m.document_id AND e.target_id=m.id AND e.type='edit' AND e.seq<=? ORDER BY e.seq DESC LIMIT 1),m.body) AS body FROM annotation_events m WHERE m.document_id=? AND m.id=?`).get(state.snapshot, doc.id, ref.id);
            const json = JSON.stringify(row);
            if (!fragmentOffset && bytes(row) + 1 <= available) {
                messages.push(row);
                available -= bytes(row) + 1;
                after = ref.seq;
                continue;
            }
            if (messages.length) {
                more = true;
                break;
            }
            const fragment = this.fragment(ref, json, fragmentOffset, available);
            messages.push(fragment);
            fragmentOffset = fragment.fragment.nextOffset ?? 0;
            if (!fragmentOffset)
                after = ref.seq;
            more = fragmentOffset > 0 || refs.length > 1;
            break;
        }
        return { documentId: doc.id, bodyRevision: state.revision, thread: summary, messages, maxBytes, continuation: more ? this.continuation(path, { ...state, after, fragmentOffset }) : null };
    }
    event(path: string, eventId: string, options: {
        offset?: number;
        maxBytes?: number;
    } = {}) {
        const maxBytes = budget(options), offset = bound(options.offset, 0, 0, Number.MAX_SAFE_INTEGER), doc = this.document(path), json = this.payload(doc.id, eventId);
        if (offset > json.length)
            fail("Offset is beyond this event.");
        if (offset === 0 && Buffer.byteLength(json) < maxBytes - 200)
            return { event: JSON.parse(json), maxBytes };
        const event = JSON.parse(json) as EventRef;
        return { ...this.fragment({ id: event.id, seq: event.seq }, json, offset, maxBytes - 200), maxBytes };
    }
    outline(path: string, body: string, options: {
        offset?: number;
        maxBytes?: number;
    } = {}) {
        const revision = this.remember(path, body), maxBytes = budget(options), offset = bound(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        type Node = {
            type: string;
            depth?: number;
            value?: string;
            children?: Node[];
            position?: {
                start: {
                    line: number;
                };
            };
        };
        const tree = unified().use(remarkParse).parse(body) as Node, headings: {
            level: number;
            title: string;
            line: number;
        }[] = [];
        const text = (n: Node): string => n.value ?? (n.children ?? []).map(text).join("");
        const visit = (n: Node) => { if (n.type === "heading")
            headings.push({ level: n.depth!, title: fitText(text(n), 400), line: n.position!.start.line }); for (const c of n.children ?? [])
            visit(c); };
        visit(tree);
        const page: typeof headings = [];
        let available = maxBytes - 300, index = offset;
        for (; index < headings.length; index++) {
            if (bytes(headings[index]) + 1 > available)
                break;
            page.push(headings[index]!);
            available -= bytes(headings[index]) + 1;
        }
        return { bodyRevision: revision, headings: page, nextOffset: index < headings.length ? index : null, totalHeadings: headings.length, maxBytes };
    }
    context(path: string, body: string, threadId: string, options: {
        radius?: number;
        maxBytes?: number;
    } = {}) {
        const maxBytes = budget(options), doc = this.document(path), revision = this.remember(path, body);
        const row = this.store.db.query("SELECT anchor_json FROM annotation_events WHERE document_id=? AND id=? AND type='comment'").get(doc.id, threadId) as {
            anchor_json: string;
        } | null;
        if (!row)
            fail("Annotation thread not found.");
        const anchor = JSON.parse(row.anchor_json) as {
            exact: string;
            prefix: string;
            suffix: string;
        }, projection = markdownProjection(body);
        let start = projection.indexOf(anchor.exact), count = 0, located = -1;
        // Context distinguishes repeated quotes using stored surrounding text when possible.
        while (start >= 0 && anchor.exact) {
            count++;
            if ((!anchor.prefix || projection.slice(0, start).endsWith(anchor.prefix)) && (!anchor.suffix || projection.slice(start + anchor.exact.length).startsWith(anchor.suffix)))
                located = located === -1 ? start : -2;
            start = projection.indexOf(anchor.exact, start + 1);
        }
        const status = count === 0 ? "orphaned" : count === 1 || located >= 0 ? "located" : "ambiguous";
        const position = status === "located" ? (located >= 0 ? located : projection.indexOf(anchor.exact)) : null;
        const radius = bound(options.radius, 300, 1, 10000);
        const contextStart = position === null ? 0 : Math.max(0, position - radius), text = position === null ? "" : fitText(projection.slice(contextStart, position + anchor.exact.length + radius), maxBytes - 600);
        return { bodyRevision: revision, threadId, anchorStatus: status, occurrences: count, projectionStart: position, contextStart: position === null ? null : contextStart, text, truncated: position !== null && contextStart + text.length < projection.length, maxBytes };
    }
    diff(path: string, body: string, fromRevision: string, options: {
        maxBytes?: number;
    } = {}) {
        const prior = this.revisions.get(`${this.document(path).id}:${fromRevision}`), revision = this.remember(path, body), maxBytes = budget(options);
        if (fromRevision === revision)
            return { bodyRevision: revision, fromRevision, status: "unchanged", changes: [], maxBytes };
        if (prior !== undefined) {
            let start = 0;
            while (start < prior.length && start < body.length && prior[start] === body[start])
                start++;
            if (start > 0 && /[\uD800-\uDBFF]/.test(prior[start - 1]!))
                start--;
            let oldEnd = prior.length, newEnd = body.length;
            while (oldEnd > start && newEnd > start && prior[oldEnd - 1] === body[newEnd - 1]) {
                oldEnd--;
                newEnd--;
            }
            if (oldEnd < prior.length && /[\uDC00-\uDFFF]/.test(prior[oldEnd]!)) {
                oldEnd++;
                newEnd++;
            }
            const oldText = prior.slice(start, oldEnd), newText = body.slice(start, newEnd), allowance = Math.floor((maxBytes - 700) / 2);
            const before = fitText(oldText, allowance), after = fitText(newText, allowance);
            return { bodyRevision: revision, fromRevision, status: "changed", changes: [{ start, oldEnd, newEnd, startLine: prior.slice(0, start).split("\n").length, before, after, beforeOmitted: oldText.length - before.length, afterOmitted: newText.length - after.length }], maxBytes };
        }
        // Restart, eviction, or a large body can make a previously seen revision unavailable.
        const fallback = this.outline(path, body, { maxBytes: Math.max(2048, maxBytes - 400) });
        const result = { bodyRevision: revision, fromRevision, status: "revision_unavailable", fallback, maxBytes };
        while (bytes(result) > maxBytes && fallback.headings.length) {
            fallback.headings.pop();
            fallback.nextOffset = fallback.headings.length;
        }
        return result;
    }
}
