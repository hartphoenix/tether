import type { TetherConfig } from "../server/config";
import { controlRequest } from "../server/lifecycle";
import type { FolioSnapshot } from "../recents/service";
import type { ReaderBackend, ReaderConnection, RemoteFolioEntry } from "./contracts";

/** Desktop owns paths, conversations and preferences; the phone owns its browser assets. */
export class DesktopReaderBackend implements ReaderBackend {
  constructor(private config: TetherConfig, private assets: ReaderBackend, private initialId: string, private requestControl: typeof controlRequest = controlRequest) {}

  private snapshot() {
    return this.requestControl<FolioSnapshot>(this.config, "/control/folio/list", { view: "all" }, { start: false });
  }
  async list(): Promise<RemoteFolioEntry[]> {
    const { files } = await this.snapshot();
    return files.map(file => ({ id: file.id, title: file.name, directory: file.directory,
      view: file.view, pinned: file.pinned, attentionCount: file.attentionCount,
      opened: file.openedAt, modified: file.modifiedAt ?? 0, activity: file.activityAt ?? 0,
      unavailable: file.missing || !!file.fileIssue }));
  }
  private memberRecord(id: string) {
    return this.requestControl<{ id: string; path: string; title: string; machineId?: string } | null>(this.config, "/control/folio/member", { id }, { start: false });
  }
  async member(id: string) {
    const value = await this.memberRecord(id);
    return value ? { id: value.id, title: value.title } : null;
  }
  async open(id: string): Promise<ReaderConnection> {
    if (id === this.initialId) return this.assets.open(id);
    const file = await this.memberRecord(id);
    if (!file) throw new Error("Document is unavailable in desktop Folio.");
    // Older daemons have a local-only catalog and accept paths. A machine-aware
    // daemon must always receive the UUID, even when its launch later fails.
    const machineAware = Object.hasOwn(file, "machineId");
    if (machineAware && (typeof file.machineId !== "string" || !file.machineId)) throw new Error("Invalid desktop machine identity.");
    const address = machineAware ? { documentId: file.id } : { path: file.path };
    const launch = await this.requestControl<{ url: string; revocable?: boolean }>(this.config, "/control/launch", { ...address, target: { host: "browser" } }, { start: false });
    if (!launch.revocable) throw new Error("Desktop Tether needs an update to support revocable phone sessions.");
    const url = new URL(launch.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid desktop origin.");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const root = response.headers.get("location"), cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (response.status !== 302 || !root || !/^\/s\/[A-Za-z0-9_-]+\/$/.test(root) || !cookie?.startsWith("tether_session=")) throw new Error("Could not open desktop document.");
    const base = new URL(root, url.origin), controller = new AbortController();
    let frontend: ReaderConnection;
    try { frontend = await this.assets.open(this.initialId); }
    catch (error) {
      await this.requestControl(this.config, "/control/session/revoke", { id: root.split("/")[2] }, { start: false }).catch(() => {});
      throw error;
    }
    return {
      request: async (resource, request) => {
        if (controller.signal.aborted) throw new Error("Reader closed.");
        if (!resource.startsWith("api/")) return frontend.request(resource, request);
        const target = new URL(resource, base);
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error("Invalid resource.");
        return fetch(target, { method: request.method, headers: { cookie, origin: base.origin, "content-type": "application/json", ...(request.headers.has("if-none-match") ? { "if-none-match": request.headers.get("if-none-match")! } : {}), ...(request.headers.has("x-tether-location-version") ? { "x-tether-location-version": request.headers.get("x-tether-location-version")! } : {}) },
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual",
          signal: AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(30_000)]) });
      },
      close: async () => {
        if (controller.signal.aborted) return;
        controller.abort(); await frontend.close();
        await this.requestControl(this.config, "/control/session/revoke", { id: root.split("/")[2] }, { start: false });
      },
    };
  }
}
