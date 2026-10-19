import { validateControlResponse } from "../src/server/lifecycle";
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentService } from '../src/documents/document-service';
import { PrivateStore } from '../src/storage/private-store';
import { bodyRevision, createAnchor, resolveAnchor } from '../src/core/annotation-ledger';
import { encodePng, decodePng, renderEvidence } from '../src/documents/visual-png';
import { validateRegion, validateVisual } from '../src/core/visual-anchor';
import { AgentReads } from '../src/documents/agent-reads';
const png = encodePng({ width: 30, height: 20, data: new Uint8Array(30 * 20 * 4).fill(255) });
const hash = 'sha256:' + createHash('sha256').update(png).digest('hex');
const body = 'Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter\n';
const projection = 'Before\nflowchart LR\n A --> B\nAfter';
const revision = bodyRevision(body);
function anchor() {
    return { ...createAnchor(projection, 7, projection.length - 6, revision), visual: { version: 1 as const, kind: 'mermaid' as const, source: 'flowchart LR\n A --> B', occurrences: 1, layoutRevision: hash, evidence: hash, width: 30, height: 20, region: { x: .1, y: .1, width: .4, height: .5 } } };
}
test('visual rectangles reject non-finite, empty and out of bounds geometry', () => {
    for (const r of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: .8, y: 0, width: .3, height: 1 }])
        expect(() => validateRegion(r)).toThrow();
});
test('diagram element targets survive validation and reject malformed names', () => {
    expect(validateVisual({ ...anchor().visual, targets: ['pele-node:Write draft', 'pele-edge:L_A_B_0'] }).targets).toEqual(['pele-node:Write draft', 'pele-edge:L_A_B_0']);
    expect(validateVisual({ ...anchor().visual, target: 'pele-node:C' } as never).targets).toEqual(['pele-node:C']);
    expect(validateVisual(anchor().visual).targets).toBeUndefined();
    const box = { x: .2, y: .2, width: .1, height: .1 };
    expect(validateVisual({ ...anchor().visual, targets: ['pele-point:A'], targetBox: box }).targetBox).toEqual(box);
    expect(validateVisual({ ...anchor().visual, targetBox: box }).targetBox).toBeUndefined();
    expect(() => validateVisual({ ...anchor().visual, targets: ['pele-point:A'], targetBox: { ...box, width: 2 } })).toThrow();
    for (const targets of [[], [''], ['node'], [':A'], ['Pele-node:A'], ['pele-node:' + 'x'.repeat(513)], Array(33).fill('pele-node:A')])
        expect(() => validateVisual({ ...anchor().visual, targets })).toThrow();
});
test('bounded PNG evidence produces readable overview and exact crop dimensions', () => {
    expect(decodePng(png).data.every(n => n === 255)).toBe(true);
    expect(decodePng(renderEvidence(decodePng(png), [anchor().visual.region], 'crop')).width).toBe(12);
    expect(decodePng(renderEvidence(decodePng(png), [anchor().visual.region], 'overview')).height).toBe(20);
    expect(() => decodePng(png.subarray(0, -10))).toThrow();
});
test('duplicate visual occurrences do not attach to the survivor after deletion', () => {
    const a = { ...createAnchor('x\nasset\ny\nasset\nz', 2, 7, revision), visual: { ...anchor().visual, occurrences: 2 } };
    expect(resolveAnchor(a, 'y\nasset\nz').status).toBe('orphan');
});
test('visual creation, retained evidence, receipts, reanchor conflicts, package and restart', async () => {
    const root = await mkdtemp('/tmp/tether-visual-test-'), path = join(root, 'doc.md'), db = join(root, 'private.sqlite');
    let store = new PrivateStore(db);
    try {
        await writeFile(path, body);
        let service = new DocumentService({ store });
        let grant = await service.open(path);
        const input = { session: grant, type: 'comment' as const, actor: 'human', body: 'Check region', anchor: anchor(), expectedBodyRevision: revision, currentVisualRevision: hash, operationId: 'create' };
        await expect(service.appendEvent(input)).rejects.toThrow('evidence');
        expect((await service.read(grant)).annotations.threads).toHaveLength(0);
        const created = await service.appendEvent({ ...input, evidenceData: png.toString('base64') });
        const thread = (created.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread);
        expect((await service.appendEvent({ ...input, evidenceData: png.toString('base64') })).mutation.replayed).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(body);
        const replacement = { ...anchor(), visual: { ...anchor().visual, region: { x: .2, y: .2, width: .3, height: .3 } } };
        const mutation = { session: grant, type: 'reanchor' as const, actor: 'human', threadId: thread.id, anchor: replacement, expectedBodyRevision: revision, expectedThreadSequence: thread.latestEvent.seq, currentVisualRevision: hash, operationId: 'redraw' };
        const updated = await service.appendEvent(mutation);
        expect((updated.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread).anchorHistory).toHaveLength(1);
        expect((updated.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread).comment.anchor).toEqual(anchor());
        await expect(service.appendEvent({ ...mutation, operationId: 'stale' })).rejects.toThrow('thread changed');
        expect((await service.appendEvent(mutation)).mutation.replayed).toBe(true);
        const historic = await service.visual(grant, thread.id, 'overview', 0, 0);
        expect(historic.regions[0]!.region).toEqual(anchor().visual.region);
        await writeFile(path, body + 'Changed');
        await expect(service.appendEvent({ ...mutation, operationId: 'changed-body', expectedThreadSequence: 2 })).rejects.toThrow('body revision');
        await writeFile(path, body);
        const exported = await service.exportReviews([grant]);
        expect(exported.version).toBe(2);
        const [imported] = await service.importReviews(exported, join(root, 'import'));
        const ig = await service.open(imported!);
        const it = ((await service.read(ig)).annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread);
        expect(it.anchorHistory).toHaveLength(1);
        expect((await service.evidence(ig, it.id)).equals(png)).toBe(true);
        store.close();
        store = new PrivateStore(db);
        service = new DocumentService({ store });
        grant = await service.open(path);
        const overview = await service.visual(grant, thread.id);
        expect(overview.verification).toBe('unverified');
        expect(decodePng(Buffer.from(await readFile(overview.artifact))).width).toBe(30);
        const context = new AgentReads(store).context(grant.path, body, thread.id);
        expect(context).toMatchObject({ retrieval: 'visual', region: replacement.visual.region });
        expect(validateControlResponse('/control/document/context', context)).toBe(true);
        await service.deleteConversation(grant.path);
        expect(store.db.query('SELECT COUNT(*) AS n FROM visual_evidence WHERE document_id=?').get(created.annotations.header!.documentId!)).toEqual({ n: 0 });
    }
    finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('text reanchor preserves messages and resolution and agent context uses effective anchor', async () => {
    const root = await mkdtemp('/tmp/tether-text-reattach-');
    const store = new PrivateStore();
    try {
        const path = join(root, 'doc.md');
        await writeFile(path, 'Old and New');
        const service = new DocumentService({ store }), grant = await service.open(path), revision = bodyRevision('Old and New');
        const created = await service.appendEvent({ session: grant, type: 'comment', actor: 'human', body: 'Question', anchor: createAnchor('Old and New', 0, 3, revision), expectedBodyRevision: revision });
        const t = (created.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread);
        await service.appendEvent({ session: grant, type: 'resolve', actor: 'human', threadId: t.id });
        const updated = await service.appendEvent({ session: grant, type: 'reanchor', actor: 'human', threadId: t.id, anchor: createAnchor('Old and New', 8, 11, revision), expectedBodyRevision: revision, expectedThreadSequence: 2 });
        expect((updated.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread).status).toBe('resolved');
        expect((updated.annotations.threads![0]! as import("../src/core/annotation-ledger").DerivedThread).comment.anchor.exact).toBe('Old');
        expect(new AgentReads(store).context(grant.path, 'Old and New', t.id).projectionStart).toBe(8);
    }
    finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('source-aware block matching preserves unique moves and rejects a different image elsewhere', async () => {
    const { locateVisualBlock } = await import('../src/core/visual-anchor');
    const { markdownProjectionDetails } = await import('../src/server/quote-anchor');
    const original = 'Before\n\n![A](a.png)\n\nAfter';
    const d = markdownProjectionDetails(original);
    const a = { ...createAnchor(d.projection, 7, 8, bodyRevision(original)), visual: { ...anchor().visual, kind: 'image' as const, source: 'a.png', occurrences: 1 } };
    const moved = markdownProjectionDetails('New heading\n\n![A](a.png)\n\nOther text');
    expect(locateVisualBlock(a, moved.projection, moved.blocks)?.source).toBe('a.png');
    const different = markdownProjectionDetails('Other heading\n\n![B](b.png)\n\nDifferent context');
    expect(locateVisualBlock(a, different.projection, different.blocks)).toBeNull();
    const replacement = markdownProjectionDetails(original.replace('a.png', 'b.png'));
    expect(locateVisualBlock(a, replacement.projection, replacement.blocks)?.source).toBe('b.png');
    const duplicates = markdownProjectionDetails('Before\n\n![A](a.png)\n\nMiddle\n\n![A](a.png)\n\nAfter');
    const duplicate = { ...createAnchor(duplicates.projection, 7, 8, revision), visual: { ...a.visual, occurrences: 2 } };
    const survivor = markdownProjectionDetails('Middle\n\n![A](a.png)\n\nAfter');
    expect(locateVisualBlock(duplicate, survivor.projection, survivor.blocks)).toBeNull();
});
test('local image replacement without Markdown edits rejects stale capture and retains evidence', async () => {
    const root = await mkdtemp('/tmp/tether-image-revision-'), store = new PrivateStore(join(root, 'store.sqlite'));
    try {
        const path = join(root, 'doc.md'), image = join(root, 'local.png'), body = 'Before\n\n![A](local.png)\n\nAfter';
        await writeFile(path, body);
        await writeFile(image, png);
        const service = new DocumentService({ store }), grant = await service.open(path), revision = bodyRevision(body);
        const a = { ...createAnchor('Before\n\uFFFC\nAfter', 7, 8, revision), visual: { ...anchor().visual, kind: 'image' as const, source: 'local.png', sourceRevision: hash } };
        const created = await service.appendEvent({ session: grant, type: 'comment', actor: 'human', body: 'Region', anchor: a, expectedBodyRevision: revision, currentVisualRevision: hash, evidenceData: png.toString('base64') });
        const thread = created.annotations.threads[0] as import('../src/core/annotation-ledger').DerivedThread;
        const changed = encodePng({ width: 30, height: 20, data: new Uint8Array(30 * 20 * 4).fill(100) });
        await writeFile(image, changed);
        await expect(service.appendEvent({ session: grant, type: 'reanchor', actor: 'human', threadId: thread.id, anchor: a, expectedBodyRevision: revision, expectedThreadSequence: 1, currentVisualRevision: hash })).rejects.toThrow('image changed');
        expect((await service.visual(grant, thread.id)).attachment).toBe('stale');
        expect((await service.evidence(grant, thread.id)).equals(png)).toBe(true);
        await expect(service.importReviews({ format: 'tether-review', version: 999, documents: [] }, join(root, 'import'))).rejects.toThrow();
    }
    finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});
