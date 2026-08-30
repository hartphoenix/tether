import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserHost } from "../src/hosts/browser";
import { HostGateway, removeWaveBridge, startWaveBridge, stopWaveBridge, writeWaveBridge } from "../src/hosts/wave-bridge";
import { ensureControlToken, prepareConfig, resolveConfig } from "../src/server/config";

const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const bridgeConfigs: ReturnType<typeof resolveConfig>[] = [];
afterEach(async () => {
  for (const config of bridgeConfigs.splice(0)) await stopWaveBridge(config).catch(() => {});
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("runs a credential-isolated bridge process for Wave actions after the launcher exits", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-wave-bridge-process-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "bridge-process", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  bridgeConfigs.push(config);
  await prepareConfig(config);
  await ensureControlToken(config);
  const bin = join(directory, "bin");
  await mkdir(bin);
  const log = join(directory, "wsh.log");
  const wsh = join(bin, "wsh");
  await writeFile(wsh, `#!/bin/sh\nif [ "$1" = version ]; then echo 'wsh v0.14.5'; else printf '%s\\n' "$*" >> '${log}'; fi\n`);
  await chmod(wsh, 0o700);
  await startWaveBridge(config, { PATH: `${bin}:/usr/bin:/bin`, WAVETERM: "1", TERM_PROGRAM: "waveterm", WAVETERM_JWT: "memory-only" });
  const gateway = new HostGateway(config, createBrowserHost({ open: async () => {} }));
  await gateway.openView("http://127.0.0.1:8420/launch?ticket=one", { host: "wave", version: "0.14.5" });
  expect(await readFile(log, "utf8")).toContain("createblock web url=http://127.0.0.1:8420/launch?ticket=one web:hidenav=true");
  await stopWaveBridge(config);
});

test("routes Wave session opens through the authenticated bridge without exposing document authority", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-wave-bridge-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "bridge", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  await prepareConfig(config);
  const token = await ensureControlToken(config);
  const received: Array<{ auth: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push({ auth: request.headers.get("authorization"), body: request.method === "POST" ? await request.json() : null });
    return Response.json({ opened: true });
  } });
  servers.push(server);
  await writeWaveBridge(config, { pid: process.pid, origin: `http://127.0.0.1:${server.port}`, instanceId: "bridge-one", startedAt: new Date().toISOString() });
  const fallbackOpened: string[] = [];
  const gateway = new HostGateway(config, createBrowserHost({ open: async (url) => { fallbackOpened.push(url); } }));
  await gateway.openView("http://127.0.0.1:8420/launch?ticket=opaque", { host: "wave", version: "0.14.5", workspaceId: "one", tabId: "two" });
  expect(received).toEqual([{ auth: `Bearer ${token}`, body: { url: "http://127.0.0.1:8420/launch?ticket=opaque", target: { host: "wave", version: "0.14.5", workspaceId: "one", tabId: "two" } } }]);
  expect(fallbackOpened).toEqual([]);
  expect(gateway.capabilities({ host: "wave", version: "0.14.5" }).hiddenNavigation).toBe(true);
  await removeWaveBridge(config);
  await expect(gateway.openView("http://127.0.0.1:8420/", { host: "wave" })).rejects.toThrow("Relaunch Tether from Wave");
});
