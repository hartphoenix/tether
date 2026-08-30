import { createWaveHost } from "./wave";
import { removeWaveBridge, writeWaveBridge } from "./wave-bridge";
import { prepareConfig, readControlToken, resolveConfig } from "../server/config";
import type { HostTarget } from "./host-adapter";

const config = resolveConfig();
await prepareConfig(config);
const token = await readControlToken(config);
if (!token || !process.env.WAVETERM_JWT) throw new Error("Wave bridge credentials are unavailable.");
const host = createWaveHost();
if (!await host.detect()) throw new Error("Wave host is unavailable.");

const instanceId = crypto.randomUUID();
let stopped = false;
let lastUsed = Date.now();
let resolveClosed!: () => void;
const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
const idleMs = Number(process.env.TETHER_WAVE_BRIDGE_IDLE_MS ?? 300_000);
const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (!authorized(request)) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  lastUsed = Date.now();
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "tether-wave-bridge", instanceId });
  if (request.method === "POST" && url.pathname === "/stop") { queueMicrotask(() => shutdown()); return json({ stopping: true }); }
  if (request.method === "POST" && url.pathname === "/open") {
    try {
      const body = await request.json() as { url?: unknown; target?: HostTarget };
      if (typeof body.url !== "string") throw new Error("A URL is required.");
      const destination = new URL(body.url);
      if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1") throw new Error("Only Tether loopback URLs may be opened.");
      await host.openView(destination.toString(), body.target);
      return json({ opened: true });
    } catch (cause) {
      return json({ error: { code: "open_failed", message: cause instanceof Error ? cause.message : String(cause) } }, 502);
    }
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
} });

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  server.stop(true);
  await removeWaveBridge(config, instanceId);
  resolveClosed();
}

const timer = setInterval(() => { if (Date.now() - lastUsed >= idleMs) void shutdown(); }, Math.min(idleMs, 10_000));
await writeWaveBridge(config, { pid: process.pid, origin: `http://127.0.0.1:${server.port}`, instanceId, startedAt: new Date().toISOString() });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());
await closed;
