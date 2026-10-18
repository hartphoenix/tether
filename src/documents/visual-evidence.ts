import { invalidRequest } from "../shared/control-input";
import { imageReferences } from "./image-assets";
import { constants } from "node:fs";
import { createHash } from 'node:crypto';
import { mkdir, writeFile, realpath, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAnnotationState, type AnnotationAnchor } from '../core/annotation-ledger';
import { VISUAL_LIMITS, locateVisualBlock } from '../core/visual-anchor';
import type { PrivateStore } from '../storage/private-store';
import { markdownProjectionDetails } from '../server/quote-anchor';
import { decodePng, renderEvidence } from './visual-png';
export function evidenceTable(store: PrivateStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS visual_evidence(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, hash TEXT NOT NULL, png BLOB NOT NULL, PRIMARY KEY(document_id,hash))`);
}
export function saveEvidence(store: PrivateStore, path: string, anchor: AnnotationAnchor, data: unknown) {
    const visual = anchor.visual;
    if (!visual)
        return;
    evidenceTable(store);
    const id = store.documentForPath(path)!.id;
    const existing = store.db.query('SELECT png FROM visual_evidence WHERE document_id=? AND hash=?').get(id, visual.evidence) as {
        png: Uint8Array;
    } | null;
    if (existing) {
        const p = decodePng(Buffer.from(existing.png));
        if (p.width !== visual.width || p.height !== visual.height)
            throw invalidRequest('Evidence dimensions do not match.');
        return;
    }
    if (typeof data !== 'string' || data.length > Math.ceil(VISUAL_LIMITS.bytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
        throw invalidRequest('Required visual evidence is missing or invalid.');
    const png = Buffer.from(data, 'base64'), hash = 'sha256:' + createHash('sha256').update(png).digest('hex');
    if (hash !== visual.evidence)
        throw invalidRequest('Evidence hash does not match.');
    const p = decodePng(png);
    if (p.width !== visual.width || p.height !== visual.height)
        throw invalidRequest('Evidence dimensions do not match.');
    store.db.query('INSERT INTO visual_evidence VALUES(?,?,?)').run(id, hash, png);
}
export function readEvidence(store: PrivateStore, path: string, hash: string): Buffer {
    evidenceTable(store);
    const row = store.db.query('SELECT png FROM visual_evidence WHERE document_id=? AND hash=?').get(store.documentForPath(path)!.id, hash) as {
        png: Uint8Array;
    } | null;
    if (!row)
        throw Object.assign(Error('Saved visual evidence is unavailable.'), { code: 'evidence_missing', status: 404 });
    return Buffer.from(row.png);
}
export function visualStatus(anchor: AnnotationAnchor, body: string, revision: string) {
    const details = markdownProjectionDetails(body), location = locateVisualBlock(anchor, details.projection, details.blocks, revision);
    const changed = Boolean(location && location.source !== anchor.visual?.source);
    return { attachment: !location ? 'orphaned' : changed ? 'stale' : 'located', verification: changed ? 'verified' : 'unverified' };
}
export async function visualOverview(store: PrivateStore, path: string, body: string, revision: string, threadId: string, mode: 'overview' | 'crop' | 'clean' = 'overview', offset = 0, history?: number) {
    if (!['overview', 'crop', 'clean'].includes(mode) || !Number.isSafeInteger(offset) || offset < 0)
        throw invalidRequest('Invalid visual retrieval options.');
    const threads = deriveAnnotationState(store.ledger(path, revision)).threads;
    const thread = threads.find(t => t.id === threadId);
    if (!thread?.anchor.visual)
        throw invalidRequest('Thread has no visual anchor.');
    const a = history === undefined ? thread.anchor : thread.anchorHistory[history];
    if (!a?.visual)
        throw invalidRequest("Historical visual anchor unavailable.");
    const v = a.visual;
    const matching = mode === 'overview' && history === undefined ? threads.filter(t => !t.deleted && t.status === thread.status && t.anchor.visual?.evidence === v.evidence && t.anchor.visual.layoutRevision === v.layoutRevision && t.anchor.bodyRevision === a.bodyRevision && t.anchor.projectionStart === a.projectionStart) : [{ ...thread, anchor: a }];
    const group = matching.slice(offset, offset + VISUAL_LIMITS.regions);
    if (!group.length)
        throw invalidRequest('No regions at this offset.');
    let status: {
        attachment: string;
        verification: string;
    } = visualStatus(a, body, revision);
    if (v.kind === 'image' && v.sourceRevision && status.attachment === 'located') {
        try {
            const current = await currentImageRevision(path, body, v.source);
            if (current && current !== v.sourceRevision)
                status = { attachment: "stale", verification: "verified" };
        }
        catch {
            status = { attachment: "stale", verification: "unverified" };
        }
    }
    const png = readEvidence(store, path, v.evidence);
    const artifact = mode === 'clean' ? png : renderEvidence(decodePng(png), group.map(t => t.anchor.visual!.region), mode);
    if (artifact.length > VISUAL_LIMITS.bytes)
        throw invalidRequest("Requested artifact exceeds 8 MiB.");
    const folder = join(store.path === ':memory:' ? tmpdir() : dirname(store.path), 'visual-artifacts', store.documentForPath(path)!.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const artifactPath = join(folder, createHash('sha256').update(artifact).digest('hex') + '.png');
    await writeFile(artifactPath, artifact, { mode: 0o600 });
    return { status: 'available', history: history ?? null, artifact: artifactPath, mimeType: 'image/png', mode, visualRevision: v.layoutRevision, evidence: v.evidence, width: v.width, height: v.height, ...status, regions: group.map((t, i) => ({ number: i + 1, threadId: t.id, comment: t.comment.body.slice(0, 1000), region: t.anchor.visual!.region, ...(t.anchor.visual!.targets ? { targets: t.anchor.visual!.targets } : {}) })), nextOffset: offset + group.length < matching.length ? offset + group.length : null, operations: ['visual --mode crop', 'visual --mode clean'], load: 'Open the artifact path with your image/vision tool.' };
}
/** Read only a currently referenced local asset; never fetch a remote image. */
export async function currentImageRevision(path: string, body: string, source: string): Promise<string | undefined> {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source))
        return undefined;
    if (!imageReferences(body).has(source))
        throw invalidRequest('Image is no longer referenced.');
    const relative = decodeURIComponent(source.split(/[?#]/, 1)[0]!);
    if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0'))
        throw invalidRequest('Invalid local image reference.');
    const target = resolve(dirname(path), relative), canonical = await realpath(target);
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 32 * 1024 * 1024)
            throw invalidRequest('Unsupported local image.');
        const bytes = await file.readFile();
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(target) !== canonical)
            throw invalidRequest('Image changed while reading.');
        return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    }
    finally {
        await file.close();
    }
}
