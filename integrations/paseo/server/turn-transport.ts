import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { TetherRunner } from "./tether-cli";
import type { HostSignal, HostSubscription } from "../shared/turns";

export type TurnSnapshot = { revision: number; subscriptions: HostSubscription[]; signals: HostSignal[] };
export type TurnTransport = {
  command(input: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  events(hostId: string, receive: (snapshot: TurnSnapshot) => void): Promise<void>;
};
type Endpoint = { origin: string; credentialPath: string; owner: string; shared: boolean };

/** Read the private credential in the plugin process; CLI output contains paths only. */
export async function connectTurnTransport(run: TetherRunner, connection: string, signal: AbortSignal): Promise<TurnTransport> {
  const endpoint = await run(["paseo", "turn-connection", ...(connection ? ["--connection", connection] : [])]) as Endpoint;
  const origin = new URL(endpoint.origin);
  if (origin.origin !== endpoint.origin || (endpoint.shared ? origin.protocol !== "https:" : origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")) throw new Error("Invalid Tether turn endpoint.");
  const file = await open(endpoint.credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 8192) throw new Error("Unsafe turn connection credential.");
    const text = await file.readFile("utf8");
    if (endpoint.shared) {
      const credential = JSON.parse(text);
      if (credential.origin !== endpoint.origin || credential.clientId !== endpoint.owner || credential.expiresAt <= Date.now()) throw new Error("Turn connection changed or expired.");
      token = credential.token;
    } else token = text.trim();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("Invalid turn credential.");
  } finally { await file.close(); }
  const request = async (path: string, init: RequestInit) => {
    const response = await fetch(endpoint.origin + path, { ...init, redirect: "manual", signal: init.signal ?? signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("Tether turn connection rejected the request."), { status: response.status }); }
    return response;
  };
  return {
    command: async (input, override) => (await request(endpoint.shared ? "/api/shared/turn.adapter" : "/control/turn/adapter", {
      method: "POST", body: JSON.stringify(input), signal: override ?? AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })).json(),
    events: async (hostId, receive) => {
      const watchdog = new AbortController();
      let timer = setTimeout(() => watchdog.abort(), 45_000);
      const response = await request((endpoint.shared ? "/api/turn-events" : "/control/turn/events") + `?hostId=${encodeURIComponent(hostId)}`, { method: "GET", signal: AbortSignal.any([signal, watchdog.signal]) }).catch(error => { clearTimeout(timer); throw error; });
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) { clearTimeout(timer); watchdog.abort(); await response.body?.cancel(); throw new Error("Tether turn events are unavailable."); }
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(timer); timer = setTimeout(() => watchdog.abort(), 45_000);
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Turn event exceeds the stream limit.");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = event.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
            if (data) {
              const snapshot = JSON.parse(data);
              if (!Array.isArray(snapshot.subscriptions) || !Array.isArray(snapshot.signals)) throw new Error("Invalid turn snapshot.");
              receive(snapshot);
            }
          }
        }
      } finally { clearTimeout(timer); watchdog.abort(); await reader.cancel().catch(() => {}); }
    },
  };
}
