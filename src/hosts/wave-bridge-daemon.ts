import { diagnosticText, errorDetails } from "../shared/diagnostics";
import { createWaveHost } from "./wave";
import { removeWaveBridge, writeWaveBridge } from "./wave-bridge";
import { prepareConfig, readControlToken, readDiscovery, resolveConfig } from "../server/config";
import type { OpenViewRequest } from "./host-adapter";
import { syncWaveRecentLaunchers } from "./wave-launchers";
import type { RecentEntry } from "../recents/registry";

const config = resolveConfig();
await prepareConfig(config);
const token = await readControlToken(config);
if (!token || !process.env.WAVETERM_JWT) throw new Error("Wave bridge credentials are unavailable.");
const host = createWaveHost();
if (!await host.detect()) throw new Error("Wave host is unavailable.");

const instanceId = crypto.randomUUID();
let stopped = false;
let resolveClosed!: () => void;
const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${token}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, async fetch(request) {
  const url = new URL(request.url);
  if (!authorized(request)) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  if (request.method === "GET" && url.pathname === "/health") {
    try { await host.probeConnection(); return json({ service: "tether-wave-bridge", instanceId, hostReady: true }); }
    catch { return json({ service: "tether-wave-bridge", instanceId, hostReady: false }); }
  }
  if (request.method === "POST" && url.pathname === "/stop") { queueMicrotask(() => shutdown()); return json({ stopping: true }); }
  if (request.method === "POST" && url.pathname === "/open") {
    try {
      const body = await request.json() as Partial<OpenViewRequest>;
      if (typeof body.url !== "string") throw new Error("A URL is required.");
      if (body.kind !== "document" && body.kind !== "recents") throw new Error("A view kind is required.");
      if (typeof body.focus !== "boolean") throw new Error("A focus preference is required.");
      const destination = new URL(body.url);
      // The authenticated caller and private profile discovery establish scope.
      // Never send the control bearer to a proposed successor listener.
      const discovery = await readDiscovery(config);
      if (!discovery || destination.origin !== discovery.origin ||
        destination.pathname !== (body.kind === "document" ? "/launch" : "/recents/launch") ||
        destination.username || destination.password || destination.hash ||
        destination.searchParams.size !== 1 || !destination.searchParams.get("ticket")) throw new Error("Only current Tether launch URLs may be opened.");
      const keys = new Set(["url", "kind", "focus", "allowFocusedFallback", "target"]);
      if (Object.keys(body).some(key => !keys.has(key)) ||
        (body.allowFocusedFallback !== undefined && typeof body.allowFocusedFallback !== "boolean")) throw new Error("Invalid Wave open request.");
      if (body.target !== undefined) {
        const target = body.target;
        const allowed = new Set(["host", "version", "workspaceId", "tabId", "blockId"]);
        if (!target || typeof target !== "object" || target.host !== "wave" ||
          Object.entries(target).some(([key, value]) => !allowed.has(key) || typeof value !== "string") ||
          [target.workspaceId, target.tabId, target.blockId].some(id => id !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) throw new Error("Invalid Wave target.");
      }
      await host.probeConnection();
      await host.openView({
        url: destination.toString(),
        kind: body.kind,
        focus: body.focus,
        ...(typeof body.allowFocusedFallback === "boolean" ? { allowFocusedFallback: body.allowFocusedFallback } : {}),
        ...(body.target ? { target: body.target } : {}),
      });
      return json({ opened: true });
    } catch (cause) {
      return json({ error: { code: "open_failed", message: diagnosticText(cause instanceof Error ? cause.message : String(cause)), details: errorDetails(cause) } }, 502);
    }
  }
  if (request.method === "POST" && url.pathname === "/recents") {
    try {
      const body = await request.json() as { entries?: unknown };
      if (!Array.isArray(body.entries) || body.entries.some((entry) => !entry || typeof entry !== "object" || typeof (entry as RecentEntry).path !== "string" || typeof (entry as RecentEntry).createdAt !== "number")) {
        throw new Error("A valid recent-entry list is required.");
      }
      await syncWaveRecentLaunchers(body.entries as RecentEntry[]);
      return json({ updated: true });
    } catch (cause) {
      return json({ error: { code: "recents_failed", message: diagnosticText(cause instanceof Error ? cause.message : String(cause)), details: errorDetails(cause) } }, 400);
    }
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
} });

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  server.stop(true);
  await removeWaveBridge(config, instanceId);
  resolveClosed();
}

await writeWaveBridge(config, { pid: process.pid, origin: `http://127.0.0.1:${server.port}`, instanceId, startedAt: new Date().toISOString() });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());
await closed;
