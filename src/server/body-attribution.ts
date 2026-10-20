import type { BodyTurn, DocumentService } from "../documents/document-service";

export type DocumentTurns = { documentId: string; turns: BodyTurn[] };

/** Serialize lifecycle observations so a completed turn's last write cannot leak into the next. */
export class BodyAttribution {
  private known = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private service: DocumentService, private snapshot: () => DocumentTurns[]) {
    service.resetBodyTurns();
  }
  sync(): Promise<void> {
    const next = this.snapshot();
    const ids = new Set(next.map(item => item.documentId));
    for (const documentId of this.known.keys()) if (!ids.has(documentId)) next.push({ documentId, turns: [] });
    for (const { documentId, turns } of next) {
      const signature = JSON.stringify(turns);
      if (this.known.get(documentId) === signature) continue;
      this.known.set(documentId, signature);
      this.tail = this.tail.then(async () => {
        try { await this.service.setBodyTurns(documentId, turns); }
        catch {
          // Missing files and disconnected machines cannot hold up host receipts.
          // A later observation must establish a new baseline before attribution resumes.
          this.known.delete(documentId);
        }
      });
    }
    return this.tail;
  }
  flush(): Promise<void> { return this.tail; }
}
