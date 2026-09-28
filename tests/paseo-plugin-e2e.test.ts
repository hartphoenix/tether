import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { controlLaunch } from "../src/server/lifecycle";
import { runCli } from "../src/cli/main";
import { resolveConfig, type TetherConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { Hub } from "../integrations/paseo/server/hub";
import { createTetherRunner } from "../integrations/paseo/server/tether-cli";
import type { PumpBatch } from "../integrations/paseo/shared/contracts";

// The plugin hub against a real daemon through the real CLI; only Paseo is simulated.
let root: string;
let config: TetherConfig;
let daemon: TetherDaemon;
let hub: Hub;
let project: string;
const saved = { ...process.env };

/** Pump from the start, following revisions, until the hub reaches a state. */
async function until(executor: boolean, check: (batch: PumpBatch) => boolean, attempts = 30): Promise<PumpBatch> {
  let revision = -1;
  let last: PumpBatch | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await hub.pump(revision, executor);
    if (check(last)) return last;
    revision = last.revision;
  }
  throw new Error(`condition not reached: ${JSON.stringify(last?.status)}`);
}

beforeAll(async () => {
  root = await realpath(await mkdtemp("/tmp/tether-paseo-e2e-"));
  const dirs = { TETHER_RUNTIME_DIR: join(root, "runtime"), TETHER_CONFIG_DIR: join(root, "config") };
  config = resolveConfig({ runtimeDir: dirs.TETHER_RUNTIME_DIR, configDir: dirs.TETHER_CONFIG_DIR });
  daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("test") });
  await daemon.ready;
  project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "plan.md"), "# Plan\n\n[[notes]]\n");
  await writeFile(join(project, "notes.md"), "# Notes\n");
  await writeFile(join(project, "agent.md"), "# Agent draft\n");
  await writeFile(join(project, "research.md"), "# Research\n");
  hub = new Hub({
    run: createTetherRunner({ binary: () => resolve("tether"), profile: () => "paseo-e2e", env: dirs }),
    pumpMs: 1_500,
    waitSeconds: 1,
  });
  hub.attach({ terminalWorkspace: async () => null });
  hub.start();
  await until(false, batch => batch.status.connected && batch.folio !== null);
}, 60_000);

afterAll(async () => {
  hub?.stop();
  await daemon?.stop();
  for (const key of ["TETHER_PASEO_WORKSPACE_ID"]) if (saved[key] === undefined) delete process.env[key];
  if (root) await rm(root, { recursive: true, force: true });
});

test("a Folio click becomes one reader tab for an executor", async () => {
  await hub.open(join(project, "plan.md"), "ws-project");
  const batch = await until(true, candidate => candidate.intents.length > 0);
  expect(batch.intents).toHaveLength(1);
  expect(batch.intents[0]!.workspaceId).toBe("ws-project");
  const exchange = await fetch(batch.intents[0]!.url, { redirect: "manual" });
  expect(exchange.status).toBe(302);
  await hub.ack([batch.intents[0]!.id]);

  // A wikilink clicked in that reader opens beside it through the same path.
  const location = exchange.headers.get("location")!;
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const clicked = await fetch(new URL("api/open", `${daemon.origin}${location}`), {
    method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ target: "notes" }),
  });
  expect(clicked.status).toBe(200);
  const linked = await until(true, candidate => candidate.intents.length > 0);
  expect(linked.intents[0]!.workspaceId).toBe("ws-project");
  expect((await fetch(linked.intents[0]!.url, { redirect: "manual" })).status).toBe(302);
  await hub.ack(linked.intents.map(intent => intent.id));
}, 60_000);

test("an agent's open and an agent's recents add each light only its own workspace's button", async () => {
  process.env.TETHER_PASEO_WORKSPACE_ID = "ws-agent";
  try {
    const opened = await runCli(["open", join(project, "agent.md")], { config });
    expect(opened.response).toMatchObject({ ok: true, data: { notified: true, opened: false } });
    // Notices can arrive before Folio has refreshed their document titles.
    const noticed = await until(true, batch => batch.notices["ws-agent"]?.name === "Agent draft");
    expect(noticed.notices).toEqual({ "ws-agent": { path: join(project, "agent.md"), name: "Agent draft" } });
    expect(noticed.intents).toEqual([]);

    process.env.TETHER_PASEO_WORKSPACE_ID = "ws-other";
    const added = await runCli(["recents", "add", join(project, "research.md")], { config });
    expect(added.response).toMatchObject({ ok: true, data: { announced: true } });
    const both = await until(false, batch => batch.notices["ws-other"]?.name === "Research");
    expect(both.notices["ws-other"]).toEqual({ path: join(project, "research.md"), name: "Research" });
  } finally { delete process.env.TETHER_PASEO_WORKSPACE_ID; }

  // A user's own opens (here, a document reached by a reader link) never announce anything.
  expect(Object.values((await hub.pump(-1, false)).notices).map(notice => notice.path)).not.toContain(join(project, "notes.md"));
}, 60_000);

test("pinning round-trips through Folio", async () => {
  await hub.pin(join(project, "plan.md"), true);
  const pinned = await until(false, batch => batch.folio?.find(entry => entry.path === join(project, "plan.md"))?.pinned === true);
  expect(pinned.folio?.[0]?.path).toBe(join(project, "plan.md"));
}, 60_000);

test("embedded Folios mint directly and route row opens to their own workspace", async () => {
  // Folio only opens registered paths; it does not grant arbitrary filesystem access.
  await runCli(["folio", "add", join(project, "plan.md"), join(project, "notes.md")], { config });
  for (const workspaceId of ["ws-embed-a", "ws-embed-b"]) {
    const launch = await hub.folioView(workspaceId);
    expect(launch.expiresAt).toBeGreaterThan(Date.now());
    expect((await hub.pump(-1, true)).intents).toEqual([]);
    const exchange = await fetch(launch.url, { redirect: "manual" });
    expect(exchange.status).toBe(302);
    const location = new URL(exchange.headers.get("location")!, daemon.origin);
    expect(location.pathname).toMatch(/^\/r\/[^/]+\/$/);
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(location)).status).toBe(401);
    const page = await fetch(location, { headers: { cookie } });
    expect(page.status).toBe(200);
    const openUrl = new URL("api/open", location);
    const options = { method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ path: join(project, "notes.md") }) };
    expect((await fetch(openUrl, { ...options, headers: { ...options.headers, origin: "http://untrusted.invalid" } })).status).toBe(403);
    expect((await fetch(openUrl, options)).status).toBe(200);
    const batch = await until(true, candidate => candidate.intents.length > 0);
    expect(batch.intents).toHaveLength(1);
    expect(batch.intents[0]!.workspaceId).toBe(workspaceId);
    expect(batch.notices[workspaceId]).toBeUndefined();
    expect((await fetch(batch.intents[0]!.url, { redirect: "manual" })).status).toBe(302);
    await hub.ack(batch.intents.map(intent => intent.id));
  }
}, 60_000);


test("Paseo theme inheritance is cookie-scoped, live, and unavailable in other hosts", async () => {
  const clientId = crypto.randomUUID();
  await hub.theme(clientId, "paseo-midnight");
  const launch = await controlLaunch(config, join(project, "notes.md"), { host: "paseo" });
  const url = new URL(launch.url); url.searchParams.set("themeClient", clientId);
  const exchange = await fetch(url, { redirect: "manual" });
  const cookie = exchange.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  expect(cookie).toContain("tether_paseo_theme=");
  const root = new URL(exchange.headers.get("location")!, daemon.origin);
  const get = async (path: string) => (await fetch(new URL(path, root), { headers: { cookie } })).json() as Promise<any>;
  expect((await get('api/bootstrap')).preferences.inheritPaseoTheme).toBe(false);
  const choose = async (body: unknown) => fetch(new URL('api/preferences', root), { method: 'PUT', headers: { cookie, origin: daemon.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await (await choose({ inheritPaseoTheme: true })).json()).theme).toBe('paseo-midnight');
  const abort = new AbortController();
  const stream = await fetch(new URL('api/theme-events', root), { headers: { cookie }, signal: abort.signal });
  const reader = stream.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('paseo-midnight');
    await hub.theme(clientId, 'paseo-ghostty');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('paseo-ghostty');
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  await hub.theme(clientId, null);
  expect((await get('api/bootstrap')).preferences.theme).toBe('paseo-ghostty');
  const normal = await controlLaunch(config, join(project, 'notes.md'), { host: 'browser' });
  const normalUrl = new URL(normal.url); normalUrl.searchParams.set('themeClient', clientId);
  const normalExchange = await fetch(normalUrl, { redirect: 'manual' });
  expect(normalExchange.headers.getSetCookie()).toHaveLength(1);
  const normalRoot = new URL(normalExchange.headers.get('location')!, daemon.origin);
  const normalCookie = normalExchange.headers.getSetCookie()[0]!.split(';')[0] + '; tether_paseo_theme=' + clientId;
  const bootstrap = await (await fetch(new URL('api/bootstrap', normalRoot), { headers: { cookie: normalCookie } })).json() as any;
  expect(bootstrap.preferences.inheritPaseoTheme).toBeUndefined();
  expect(bootstrap.preferences.theme).not.toBe('paseo-ghostty');
  const rejected = await fetch(new URL('api/preferences', normalRoot), { method: 'PUT', headers: { cookie: normalCookie, origin: daemon.origin, 'content-type': 'application/json' }, body: JSON.stringify({ inheritPaseoTheme: true }) });
  expect(rejected.status).toBe(400);
}, 15000);
