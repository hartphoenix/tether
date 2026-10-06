import type { HostAdapter, HostTarget } from "../hosts/host-adapter";
import type { ReaderAnnouncement } from "./reader-delivery";

const authorized = new WeakSet<object>();
const documentIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
declare const readerAuthority: unique symbol;

/** A public reader address authorized by the receiver's configured connection. */
export type SharedReaderLink = Readonly<{ origin: string; documentId: string; url: string; [readerAuthority]: true }>;

export function createSharedReaderLink(configuredOrigin: string, documentId: string, rawUrl: string): SharedReaderLink {
  const origin = new URL(configuredOrigin), url = new URL(rawUrl);
  if (origin.protocol !== "https:" || origin.origin !== configuredOrigin || !documentIdPattern.test(documentId)
    || url.origin !== configuredOrigin || url.username || url.password || url.search || url.hash
    || url.pathname !== `/reader/d/${documentId}/` || url.href !== rawUrl) {
    throw new Error("The announcement must name a document at the configured HTTPS reader origin.");
  }
  const reader = Object.freeze({ origin: configuredOrigin, documentId, url: rawUrl }) as SharedReaderLink;
  authorized.add(reader);
  return reader;
}

export function assertSharedReaderLink(reader: SharedReaderLink): void {
  if (!authorized.has(reader)) throw new Error("A configured shared reader capability is required.");
}

export type ReceiveReaderRequest = { reader: SharedReaderLink; target: HostTarget };
export type ReceiveReaderResult = { placement: "opened" | "announced" };
export type ReaderDeliveryResult = {
  host: string;
  placement: "opened" | "announced" | "link_available";
  nativePlacement: "supported" | "unsupported" | "failed";
  reason?: string;
};

/** Capture local placement authority once; announcements cannot retarget it. */
export function createReaderReceiver(options: { origin: string; host?: HostAdapter; now?: () => number }) {
  const target = options.host?.launchTarget?.();
  const captured = target ? Object.freeze({ ...target }) : undefined;
  return {
    async deliver(item: ReaderAnnouncement): Promise<ReaderDeliveryResult> {
      if (item.origin !== "agent" || !Number.isFinite(item.expiresAt) || item.expiresAt <= (options.now ?? Date.now)()) {
        throw new Error("The reader announcement is invalid or expired.");
      }
      const reader = createSharedReaderLink(options.origin, item.documentId, item.url);
      const host = options.host;
      if (!host?.receiveReader || !captured) return { host: host?.id ?? "browser", placement: "link_available", nativePlacement: "unsupported" };
      try {
        return { host: host.id, ...await host.receiveReader({ reader, target: captured }), nativePlacement: "supported" };
      } catch (cause) {
        const code = (cause as { code?: unknown })?.code;
        return { host: host.id, placement: "link_available", nativePlacement: "failed", reason: typeof code === "string" ? code : "host_delivery_failed" };
      }
    },
  };
}
