import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { controlRequest } from "../src/server/lifecycle";
import { resolveConfig } from "../src/server/config";
import { hasCompletedReceipt } from "../integrations/paseo/chat/receipts";
import { buildPaseoPlugin } from "./build-paseo-plugin";

// Uses a disposable Paseo daemon and deterministic provider; no model is called.
const cli = process.argv[2] ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo";
const scratch = await mkdtemp("/tmp/tether-go-runtime-");
const home = join(scratch, "paseo"), plugin = join(scratch, "plugin");
await mkdir(home, { recursive: true });
await mkdir(join(scratch, "user"));
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: "/tmp", HOME: join(scratch, "user"), PASEO_HOME: home,
  TETHER_PROFILE: "go-runtime", TETHER_CONFIG_DIR: join(scratch, "tether-config"), TETHER_RUNTIME_DIR: join(scratch, "tether-runtime"),
  TETHER_SUPPRESS_BROWSER: "1" };
await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: join(home, "daemon.sock") }, pluginsEnabled: true }));
await mkdir(join(home, "plugin-settings/tether"), { recursive: true });
await writeFile(join(home, "plugin-settings/tether/tether.json"), JSON.stringify({ version: 1, values: { tetherPath: resolve("tether"), profile: "go-runtime", sharedConnection: "", buttons: true, readerPanels: true } }));
await buildPaseoPlugin(plugin, "0.0.0");
const provider = join(scratch, "provider");
await mkdir(provider);
await writeFile(join(provider, "paseo-plugin.json"), JSON.stringify({ id: "tether-go-fixture", requirements: { paseo: ">=0.11.2" } }));
await copyFile(resolve("scripts/fixtures/turn-provider.ts"), join(provider, "index.server.ts"));
const tetherConfig = resolveConfig({ profile: "go-runtime", configDir: env.TETHER_CONFIG_DIR, runtimeDir: env.TETHER_RUNTIME_DIR });
async function run(executable: string, args: string[], extra = {}) {
  const child = Bun.spawn([executable, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`Isolated runtime check failed: ${out} ${err}`);
    return out;
  } finally { clearTimeout(timer); }
}
const host = (...args: string[]) => run(cli, [...args, "--home", home]);
const probe = join(scratch, "probe.cjs");
// The real plugin uses process.argv[1] to resolve these same host-installed modules.
const resources = resolve(cli, "../..");
await writeFile(probe, `
const { pathToFileURL } = require("node:url");
(async () => {
  const { connectToDaemon } = await import(pathToFileURL(${JSON.stringify(join(resources, "app.asar/node_modules/@getpaseo/cli/dist/utils/client.js"))}).href);
  const client = await connectToDaemon({target:{kind:"instance",home:${JSON.stringify(home)}},timeout:10000});
  try {
    if (process.argv[3] === "create") {
      const agents = [];
      for (let i=0;i<4;i++) agents.push(await client.createAgent({provider:"tether-go-fixture",model:"fixture",cwd:${JSON.stringify(scratch)},title:"Tether transport fixture "+i}));
      process.stdout.write(JSON.stringify(agents.map(agent=>agent.id))); return;
    }
    if (process.argv[3] === "metadata") {
      const result = await client.fetchAgent(process.argv[4]);
      process.stdout.write(JSON.stringify(result)); return;
    }
    if (process.argv[3] === "timeline") {
      const page = await client.fetchAgentTimeline(process.argv[4],{direction:"tail",limit:128,projection:"canonical"});
      process.stdout.write(JSON.stringify(page.entries.filter(entry=>entry.item.type==="user_message").map(entry=>entry.item))); return;
    }
    let last;
    for (let attempt=0; attempt<50; attempt++) {
      const state = await client.invokePluginRpc("tether","tether.turn-status",{}).catch(()=>null);
      last = state;
      if (state?.connected && state.connections >= Number(process.argv[2] ?? 1)) { process.stdout.write(JSON.stringify(state)); return; }
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error("Plugin did not establish its host-owned turn connection: "+JSON.stringify(last));
  } finally { await client.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
`);
const inspect = (minimum = 1, mode = "status", agent = "") => run(join(resources, "../Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"),
  [join(resources, "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js"), "node-script", probe, String(minimum), mode, agent],
  { ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" });
try {
  const version = (await run(cli, ["--version"])).trim();
  await host("daemon", "start", "--timeout", "30");
  await host("plugin", "install", plugin, "--json");
  await host("plugin", "install", provider, "--json");
  const first = JSON.parse(await inspect());
  assert.ok(first.hostId);
  const agents: string[] = JSON.parse(await inspect(1, "create"));
  const creatorPath = join(scratch, "created.md"), creatorBody = join(scratch, "created-body.txt");
  await writeFile(creatorBody, "# Creator fixture\n");
  const created = JSON.parse(await run(resolve("tether"), ["document", "create", creatorPath, "--body-file", creatorBody], { PASEO_AGENT_ID: agents[3], TETHER_PASEO_HOST_ID: first.hostId }));
  assert.equal(created.ok, true);
  assert.equal(created.data.go.registered, true);
  assert.equal(created.data.recipientId, `paseo:${agents[3]}`);
  assert.equal(created.data.identity.name, "Creator fixture");
  assert.equal((await controlRequest<any>(tetherConfig, "/control/turn/status", { path: creatorPath })).agents[0].agentId, created.data.identity.id);
  assert.deepEqual(JSON.parse(await inspect(1, "timeline", agents[3])), [], "Creation must not send a turn");
  const paths = [join(scratch, "one.md"), join(scratch, "two.md")];
  for (let i=0;i<2;i++) {
    await writeFile(paths[i]!, "# Disposable transport check\n");
    await controlRequest(tetherConfig, "/control/turn/register", { path: paths[i], actor: `Transport fixture ${i}`, agentId: `paseo:${agents[i]}`, hostId: first.hostId });
  }
  const signal = await controlRequest<any>(tetherConfig, "/control/turn/send", { path: paths[0], agentId: `paseo:${agents[0]}`, operationId: "runtime-one" });
  const replay = await controlRequest<any>(tetherConfig, "/control/turn/send", { path: paths[0], agentId: `paseo:${agents[0]}`, operationId: "runtime-one" });
  assert.equal(replay.signalId, signal.signalId);
  let ready = false;
  for (let i=0;i<80;i++) {
    const state = await controlRequest<any>(tetherConfig, "/control/turn/status", { path: paths[0] });
    if (state.agents[0]?.state === "ready") { ready = true; break; }
    await Bun.sleep(100);
  }
  assert.ok(ready, "Delivered fixture turn must restore readiness");
  const inputs = JSON.parse(await inspect(1, "timeline", agents[0]));
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].text.includes(signal.signalId));
  assert.equal(inputs[0].clientMessageId ?? inputs[0].messageId, signal.signalId);
  assert.deepEqual(JSON.parse(await inspect(1, "timeline", agents[1])), []);
  assert.equal(await hasCompletedReceipt(home, first.hostId, agents[0]!, { id: signal.signalId, messageId: signal.signalId, text: signal.text, prose: "", state: "dispatching", attachments: [], draftIds: [], wire: JSON.stringify({ text: signal.text, options: { messageId: signal.signalId, activeTurnBehavior: "steer" } }) }), true);
  await controlRequest(tetherConfig, "/control/turn/takeover", { path: paths[0], roleId: `paseo:${agents[0]}`, expectedRecipient: `paseo:${agents[0]}`, agentId: `paseo:${agents[2]}`, hostId: first.hostId });
  const replacement = await controlRequest<any>(tetherConfig, "/control/turn/send", { path: paths[0], agentId: `paseo:${agents[0]}`, operationId: "runtime-takeover" });
  let replacementReady = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await controlRequest<any>(tetherConfig, "/control/turn/status", { path: paths[0] })).agents[0]?.state === "ready") { replacementReady = true; break; }
    await Bun.sleep(200);
  }
  assert.ok(replacementReady, "Replacement session must complete the role's turn");
  const replacementInputs = JSON.parse(await inspect(1, "timeline", agents[2]));
  assert.equal(replacementInputs.length, 1);
  assert.ok(replacementInputs[0].text.includes(replacement.signalId));
  assert.equal(JSON.parse(await inspect(1, "timeline", agents[0])).length, 1, "Retired session must receive no new invitation");
  await host("plugin", "disable", "tether", "--json");
  const held = await controlRequest<any>(tetherConfig, "/control/turn/send", { path: paths[1], agentId: `paseo:${agents[1]}`, operationId: "runtime-held" });
  await run(resolve("tether"), ["daemon", "stop"]);
  // Explicitly start the isolated authority, then let the host restore its saved invitation.
  await Bun.sleep(200);
  assert.equal((await controlRequest<any>(tetherConfig, "/control/turn/status", { path: paths[1] })).agents[0].state, "queued");
  await host("plugin", "enable", "tether", "--json"); await inspect();
  let restoredReady = false;
  for (let i=0;i<80;i++) {
    if ((await controlRequest<any>(tetherConfig, "/control/turn/status", { path: paths[1] })).agents[0]?.state === "ready") { restoredReady = true; break; }
    await Bun.sleep(100);
  }
  assert.ok(restoredReady, "Held invitation must resume after authority restart and plugin enable");
  const restoredInputs = JSON.parse(await inspect(1, "timeline", agents[1]));
  assert.equal(restoredInputs.length, 1); assert.ok(restoredInputs[0].text.includes(held.signalId));
  await host("plugin", "reload", "tether", "--json");
  assert.equal(JSON.parse(await inspect()).hostId, first.hostId);
  const beforeRestart = JSON.parse(await inspect());
  await run(resolve("tether"), ["daemon", "stop"]);
  assert.equal(JSON.parse(await inspect(beforeRestart.connections + 1)).hostId, first.hostId);
  await host("daemon", "stop");
  await host("daemon", "start", "--timeout", "30");
  assert.equal(JSON.parse(await inspect()).hostId, first.hostId);
  // Read metadata before timeline: timeline itself would restore the session.
  for (const [index, recipient] of [[0, agents[2]], [1, agents[1]]] as const) {
    const metadata = JSON.parse(await inspect(1, "metadata", recipient));
    assert.equal(metadata.agent.status, "closed", "Restart must leave the provider closed until Go");
    assert.ok(!metadata.agent.archivedAt);
    if (index === 1) await controlRequest(tetherConfig, "/control/turn/register", {
      path: paths[index], actor: "Transport fixture 1", agentId: `paseo:${agents[1]}`, hostId: first.hostId, behavior: "queue",
    });
    const resumed = await controlRequest<any>(tetherConfig, "/control/turn/send", {
      path: paths[index], agentId: `paseo:${agents[index]}`, operationId: `runtime-resume-${index}`,
    });
    let completed = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await controlRequest<any>(tetherConfig, "/control/turn/status", { path: paths[index] });
      if (state.agents[0]?.state === "ready") { completed = true; break; }
      await Bun.sleep(100);
    }
    assert.ok(completed, "Go must restore and complete the same closed session");
    const timeline = JSON.parse(await inspect(1, "timeline", recipient));
    assert.equal(timeline.filter((item: any) => item.text.includes(resumed.signalId)).length, 1);
  }
  console.log(`Paseo ${version}: plugin startup without app, SDK bootstrap, plugin reload, Tether reconnect and host restart with closed-session steer/queue resume, creator auto-registration, selected-agent delivery, recipient signal IDs, durable receipts, held invitation recovery, completion and duplicate suppression passed; zero model calls. Evidence: ${scratch}`);
} finally {
  await host("daemon", "stop").catch(() => {});
  await run(resolve("tether"), ["daemon", "stop"]).catch(() => {});
}
