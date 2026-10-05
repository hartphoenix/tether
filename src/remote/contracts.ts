/** Experimental composition boundary. Locations and host credentials stay in adapters. */
export type RemoteDocument = { id: string; title: string };

export interface ReaderConnection {
  /** Relative reader resource, never a filesystem path or arbitrary URL. */
  request(resource: string, request: Request): Promise<Response>;
  close(): Promise<void>;
}

export type RemoteFolioEntry = RemoteDocument & {
  directory?: string; view?: "active" | "archive"; pinned?: boolean; attentionCount?: number;
  opened?: number; modified?: number; activity?: number; unavailable?: boolean;
};

export interface ReaderBackend {
  /** An explicit owner-authorized catalog; membership is checked again when opening. */
  list?(): Promise<RemoteFolioEntry[]>;
  member?(documentId: string): Promise<RemoteDocument | null>;
  open(documentId: string): Promise<ReaderConnection>;
}

/** Identity must come from a trusted transport, never a transcript or request body. */
export type IdentifyCaller = (request: Request) => string | null | Promise<string | null>;

export function tailscaleIdentity(owner: string): IdentifyCaller {
  if (!owner.trim()) throw new Error("An explicit Tailscale owner is required.");
  // Only use behind Serve on a loopback listener. This does not authenticate local processes.
  return request => request.headers.get("tailscale-user-login") === owner ? owner : null;
}
