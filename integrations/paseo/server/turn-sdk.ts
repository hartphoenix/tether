import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Position = { epoch: string; seq: number };
export type TimelinePage = {
  entries: { seq: number; item: { type: string; text?: string; clientMessageId?: string; messageId?: string } }[];
  endCursor: Position | null; startCursor: Position | null; hasOlder: boolean; hasNewer: boolean; epoch: string;
};
export type AgentSnapshot = { status: string; archivedAt?: string | null; pendingPermissions?: unknown[]; lastError?: unknown; activeTurn?: unknown };
export type TurnAgentHandle = {
  refresh(): Promise<{ agent: AgentSnapshot } | null>;
  send(text: string, options: { messageId: string; activeTurnBehavior: "steer" | "interrupt" }): Promise<void>;
  timeline: { refetch(options?: { direction?: "tail" | "after"; cursor?: Position; limit?: number; projection?: "canonical" }): Promise<TimelinePage> };
  subscribe(fn: () => void): () => void;
};
export type TurnHost = { hostId: string; home: string; agent(id: string): TurnAgentHandle; disconnected(fn: () => void): () => void; close(): Promise<void> };

/**
 * Paseo 0.11.2 compatibility seam: its plugin context has no startup API.
 * Resolve the installed CLI's authenticated local connector and public SDK
 * from the daemon's runtime, never from PATH or a second SDK installation.
 */
export async function connectTurnHost(): Promise<TurnHost> {
  const runtime = createRequire(process.argv[1]!);
  const connector = await import(pathToFileURL(runtime.resolve("@getpaseo/cli/dist/utils/client.js")).href);
  const sdk = await import(pathToFileURL(runtime.resolve("@getpaseo/client")).href);
  const raw = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const home = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  const hostId = (await readFile(join(home, "server-id"), "utf8")).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(hostId)) throw new Error("Paseo host identity is unavailable.");
  const client = await connector.connectToDaemon({ target: { kind: "instance", home }, timeout: 10_000 });
  const api = sdk.createPaseoApi(client);
  return {
    hostId, home,
    agent: id => api.agents.ref(id),
    disconnected: fn => client.subscribeConnectionStatus((state: { status: string }) => { if (state.status !== "connected") fn(); }),
    close: async () => { try { await api.dispose(); } finally { await client.close(); } },
  };
}
