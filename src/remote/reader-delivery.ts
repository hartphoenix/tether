import type { SharedClient } from "./shared-auth";

export type ReaderAnnouncement = { id: string; documentId: string; url: string; origin: "agent"; host?: string; workspaceId?: string; expiresAt: number };

/** Announcements are delivery hints, never credentials or permission to focus a window. */
export class ReaderDelivery {
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private readonly queues = new Map<string, ReaderAnnouncement[]>();
  constructor(private readonly origin: string, private readonly client: (id: string) => SharedClient | null, private readonly now = Date.now) {}
  enqueue(clientId: string, documentId: string, host?: string, workspaceId?: string): ReaderAnnouncement {
    if (!this.client(clientId)) throw Object.assign(new Error("The receiving client is unavailable or revoked."), { code: "receiver_unavailable", status: 404 });
    if (host !== undefined && !["browser", "paseo", "cmux", "wave"].includes(host)) throw Object.assign(new Error("Unknown receiving host."), { code: "invalid_request", status: 400 });
    if (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 256)) throw Object.assign(new Error("An explicit workspace ID is required."), { code: "invalid_workspace", status: 400 });
    const queue = this.read(clientId);
    if (queue.length >= 100 || !this.queues.has(clientId) && this.queues.size >= 256) throw Object.assign(new Error("The reader announcement queue is full."), { code: "delivery_full", status: 429 });
    const announcement: ReaderAnnouncement = { id: crypto.randomUUID(), documentId, url: `${this.origin}/reader/d/${encodeURIComponent(documentId)}/`, origin: "agent", ...(host ? { host } : {}), ...(workspaceId ? { workspaceId } : {}), expiresAt: this.now() + 300_000 };
    queue.push(announcement); this.queues.set(clientId, queue); for (const listener of this.listeners) listener(); return announcement;
  }
  read(clientId: string): ReaderAnnouncement[] {
    for (const [id, queue] of this.queues) {
      const current = this.client(id) ? queue.filter(item => item.expiresAt > this.now()) : [];
      if (!current.length) this.queues.delete(id); else this.queues.set(id, current);
    }
    return [...(this.queues.get(clientId) ?? [])];
  }
  acknowledge(clientId: string, ids: string[]): void {
    this.queues.set(clientId, this.read(clientId).filter(item => !ids.includes(item.id)));
  }
  revoke(clientId: string): void { this.queues.delete(clientId); }
}
