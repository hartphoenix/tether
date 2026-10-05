import type { TetherDaemon } from "../server/server";
import type { ReaderBackend, ReaderConnection } from "./contracts";

/** Compatibility adapter for today's daemon; the remote contract never exposes local paths. */
export class LocalReaderBackend implements ReaderBackend {
  constructor(private daemon: TetherDaemon, private locations: ReadonlyMap<string, string>) {}

  async open(documentId: string): Promise<ReaderConnection> {
    const path = this.locations.get(documentId);
    if (!path) throw new Error("Document is not registered for this reader.");
    const grant = await this.daemon.service.open(path);
    if (this.daemon.service.store.documentForPath(grant.realPath)?.id !== documentId) {
      this.daemon.service.close(grant); throw new Error("Registered document identity changed.");
    }
    const launch = this.daemon.mintTicket(grant, { host: "browser" });
    const url = new URL(launch.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid local reader origin.");
    const opened = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const root = opened.headers.get("location");
    const cookie = opened.headers.get("set-cookie")?.split(";", 1)[0];
    if (opened.status !== 302 || !root || !/^\/s\/[A-Za-z0-9_-]+\/$/.test(root) || !cookie?.startsWith("tether_session=")) {
      throw new Error("Could not establish a private upstream document session.");
    }
    const base = new URL(root, url.origin);
    let closed = false;
    const controller = new AbortController();
    return {
      request: async (resource, request) => {
        if (closed) throw new Error("Reader session closed.");
        const target = new URL(resource, base);
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error("Invalid reader resource.");
        const headers = new Headers({ cookie, origin: base.origin });
        for (const name of ["content-type", "accept", "if-none-match"]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        return fetch(target, { method: request.method, headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
          redirect: "manual", signal: AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(30_000)]) });
      },
      close: async () => { closed = true; controller.abort(); this.daemon.revokeSession(root.split("/")[2]!); },
    };
  }
}
