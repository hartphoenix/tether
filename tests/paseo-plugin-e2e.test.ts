import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
    const noticed = await until(true, batch => batch.notices["ws-agent"] !== undefined);
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
