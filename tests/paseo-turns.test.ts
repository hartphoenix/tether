import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PaseoTurnDelivery } from "../src/hosts/paseo-turns";
import { TurnSignals } from "../src/server/turns";
import { TurnStore } from "../src/server/turn-store";
import { captureTurnAnnotations } from "../src/server/turn-annotations";
import { PrivateStore } from "../src/storage/private-store";
import { ChatStore } from "../src/chat/store";
import { formatDrafts } from "../integrations/paseo/chat/model";
import { ChatController } from "../integrations/paseo/chat/controller";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";
import { createBrowserHost } from "../src/hosts/browser";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const id = "paseo:test-agent", path = "/tmp/turn.md";
const draft = { id: "draft", quote: 'A "quote"', feedback: "Please check", from: "assistant" as const };
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await Bun.sleep(10); }
  throw new Error("Condition timed out");
}
async function fixture() {
  const root = await mkdtemp("/tmp/tether-paseo-test-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "paseo"), state = join(root, "state.json"), sent = join(root, "sent.jsonl");
  await writeFile(join(root, "server-id"), "test-host");
  await writeFile(state, JSON.stringify({ status: "idle" }));
  await writeFile(sent, "");
  await writeFile(cli, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const state = () => JSON.parse(readFileSync(process.env.FAKE_STATE,'utf8'));
const op = process.argv[2];
if (op === 'inspect') { const s=state(); console.log(JSON.stringify({Id:'test-agent',Status:s.status,Archived:s.archived??false,PendingPermissions:[]})); }
else if (op === 'wait') { while(state().status==='running') await Bun.sleep(10); console.log(JSON.stringify({status:state().waitStatus??'idle'})); }
else if (op === 'api') {
 if(state().fail) process.exit(1);
 const text=readFileSync(process.argv.at(-1),'utf8'), messageId=process.argv.at(-2);
 appendFileSync(process.env.FAKE_SENT,JSON.stringify({text,messageId})+'\\n');
 writeFileSync(process.env.FAKE_STATE,JSON.stringify({status:'running'}));
 console.log(JSON.stringify({accepted:true}));
} else process.exit(2);
`);
  await chmod(cli, 0o700);
  const delivery = new PaseoTurnDelivery({ env: { ...process.env, PASEO_CLI: cli, PASEO_HOME: root, FAKE_STATE: state, FAKE_SENT: sent }, apiCommand: [cli, "api"], waitTimeoutMs: 3_000 });
  const owner = new PrivateStore(join(root, "tether.sqlite"));
  cleanup.push(async () => owner.close());
  const chat = new ChatStore(owner.db), store = new TurnStore(owner.db);
  const turns = new TurnSignals("test", Date.now, { delivery, store, capture: (agent, signal, event) => captureTurnAnnotations(chat, delivery.chatScope(agent), signal, event) });
  cleanup.push(async () => { turns.close(); await Bun.sleep(50); });
  const set = (value: Record<string, unknown>) => writeFile(state, JSON.stringify(value));
  const messages = async () => (await readFile(sent, "utf8")).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, delivery, owner, chat, store, turns, set, messages };
}
for (const annotations of [false, true]) {
  test(`idle API delivery, acceptance and turn end (${annotations ? 'with' : 'without'} annotations)`, async () => {
    const f = await fixture();
    if (annotations) f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft } });
    expect(await f.turns.register(path, id, "Review")).toMatchObject({ state: "ready", label: "Review" });
    const press = f.turns.request(path, id);
    expect(typeof (press as any).signalId).toBe("string");
    await until(() => f.turns.agents(path)[0]?.state === "working");
    const messages = await f.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe([annotations ? formatDrafts([draft]) : '', '<tether-turn path="/tmp/turn.md" />'].filter(Boolean).join('\n\n'));
    expect(messages[0].messageId).toBe((press as any).signalId);
    expect(f.chat.read('["test-host","test-agent"]')).toEqual({ drafts: [], submission: null });
    expect(f.turns.agents(path)[0]?.acceptedAt).toBeString();
    await f.set({ status: "idle" });
    await until(() => f.turns.agents(path)[0]?.state === "ready");
  });
  test(`armed watcher takes precedence (${annotations ? 'with' : 'without'} annotations)`, async () => {
    const f = await fixture();
    if (annotations) f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft } });
    await f.turns.register(path, id);
    const waiting = f.turns.wait(path, id, undefined, undefined, 2_000);
    f.turns.request(path, id);
    const result = await waiting;
    expect(typeof (result as any).turn.signalId).toBe("string");
    expect(result).toMatchObject({ turn: { agentId: id } });
    expect((result as any).annotations).toBe(annotations ? formatDrafts([draft]) : undefined);
    expect(await f.messages()).toEqual([]);
    if (annotations) expect(f.chat.read('["test-host","test-agent"]').submission?.state).toBe("dispatching");
    expect(f.turns.received(path, id, (result as any).turn.signalId)).toBe(true);
    expect(f.chat.read('["test-host","test-agent"]')).toEqual({ drafts: [], submission: null });
  });
}
test("busy agents queue without sending, then finish after a separate idle", async () => {
  const f = await fixture();
  await f.set({ status: "running" });
  await f.turns.register(path, id);
  f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft } });
  f.turns.request(path, id);
  expect(f.chat.read('["test-host","test-agent"]').submission?.state).toBe("prepared");
  f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft: { ...draft, id: "later" } } });
  expect(f.turns.agents(path)[0]?.state).toBe("queued");
  await Bun.sleep(60);
  expect(await f.messages()).toEqual([]);
  expect(f.turns.request(path, id)).toBe("working");
  await f.set({ status: "idle" });
  await until(() => f.turns.agents(path)[0]?.state === "working");
  await f.set({ status: "idle" });
  await until(() => f.turns.agents(path)[0]?.state === "ready");
  expect(f.chat.read('["test-host","test-agent"]').drafts.map(d => d.id)).toEqual(["later"]);
});

test("watcher response loss retains annotations; a receipt after restart clears exactly that batch", async () => {
  const f = await fixture();
  f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft } });
  const waiting = f.turns.wait(path, id, undefined, undefined, 2_000);
  const press = f.turns.request(path, id) as { signalId: string };
  await waiting;
  expect(f.chat.read('["test-host","test-agent"]').drafts).toHaveLength(1);
  f.turns.close();
  const restarted = new TurnSignals("new", Date.now, { store: f.store, acknowledgeAnnotations: (agentId, signalId) => {
    f.chat.operate({ ...f.delivery.chatScope(agentId), operation: { kind: "accepted", id: signalId, messageId: signalId } });
  } });
  expect(restarted.received("/wrong.md", id, press.signalId)).toBe(false);
  expect(restarted.received(path, id, press.signalId)).toBe(true);
  expect(restarted.received(path, id, press.signalId)).toBe(true);
  expect(f.chat.read('["test-host","test-agent"]')).toEqual({ drafts: [], submission: null });
  restarted.close();
});
test("archived agents and failed sends remain visibly unavailable", async () => {
  const f = await fixture();
  await f.set({ status: "idle", archived: true });
  expect(await f.turns.register(path, id)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("archived") });
  expect(f.turns.unregister(path, id)).toBe(true);
  await f.set({ status: "idle", fail: true });
  f.chat.operate({ host: "test-host", agent: "test-agent", operation: { kind: "save", draft } });
  await f.turns.register(path, id);
  f.turns.request(path, id);
  await until(() => f.turns.agents(path)[0]?.state === "unavailable");
  expect(f.chat.read('["test-host","test-agent"]').submission?.state).toBe("dispatching");
  expect(await f.messages()).toEqual([]);
  expect(f.turns.request(path, id)).toBe("unavailable");
});
test("restart exposes a dropped press and never replays it", async () => {
  const f = await fixture();
  await f.set({ status: "running" });
  await f.turns.register(path, id);
  f.turns.request(path, id);
  const restarted = new TurnSignals("new", Date.now, { delivery: f.delivery, store: f.store });
  expect(restarted.agents(path)[0]).toMatchObject({ state: "unavailable", reason: expect.stringContaining("restarted"), signalId: expect.any(String) });
  f.turns.close(); restarted.close();
  await f.set({ status: "idle" });
  await Bun.sleep(100);
  expect(await f.messages()).toEqual([]);
});
test("registrations outlast watcher grace; unregister cancels queued work", async () => {
  const f = await fixture();
  let now = 1;
  const turns = new TurnSignals("clock", () => now, { delivery: f.delivery });
  await turns.register(path, id);
  now += 60_001;
  expect(turns.agents(path)[0]?.state).toBe("ready");
  await f.set({ status: "running" });
  turns.request(path, id);
  expect(turns.unregister(path, id)).toBe(true);
  await f.set({ status: "idle" });
  await Bun.sleep(100);
  expect(turns.agents(path)).toEqual([]);
  expect(await f.messages()).toEqual([]);
  turns.close();
});
test("open composer refresh clears externally accepted drafts and cannot resurrect them", async () => {
  const f = await fixture();
  const c = new ChatController(async operation => f.chat.operate({ host: "test-host", agent: "test-agent", operation }), () => {});
  await c.save(draft);
  const batch = captureTurnAnnotations(f.chat, { host: "test-host", agent: "test-agent" }, "signal", "<tether-turn />");
  batch.dispatch("signal", { messageId: "signal", activeTurnBehavior: "steer" }); batch.accepted("signal");
  await c.refresh();
  expect(c.state.drafts).toEqual([]);
  await expect(c.save(draft)).rejects.toThrow("was delivered");
});
test("register and unregister CLI use step-one identity and reader-only press authority", async () => {
  const f = await fixture();
  const document = join(f.root, "document.md"); await writeFile(document, "Test\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(f.root, "runtime"), configDir: join(f.root, "config") });
  const daemon = createDaemon({ config, hostAdapter: Object.assign(createBrowserHost(), { turnDelivery: f.delivery }), startupGraceMs: 600_000 });
  await daemon.ready;
  cleanup.push(() => daemon.stop());
  const args = [document, "--actor", "Go Paseo delivery", "--agent-id", id];
  expect((await runCli(["turn", "register", ...args], { config })).response).toMatchObject({ ok: true, data: { registration: { agentId: id, state: "ready" } } });
  expect((await runCli(["turn", "unregister", ...args], { config })).response).toMatchObject({ ok: true, data: { removed: true } });
  expect((await runCli(["turn", "unregister", ...args], { config })).response).toMatchObject({ ok: true, data: { removed: false } });
  expect((await fetch(`${daemon.origin}/control/turn/register`, { method: "POST", body: JSON.stringify({path: document, actor:'untrusted', agentId: id}) })).status).toBe(403);
});

test("API bridge uses stable message identity and never requests interruption", async () => {
  const f = await fixture();
  const { PASEO_API_SEND } = await import("../src/hosts/paseo-api");
  const script = join(f.root, "api.cjs"), sdk = join(f.root, "sdk.mjs"), prompt = join(f.root, "prompt.txt");
  const result = join(f.root, "api-send.json");
  await writeFile(script, PASEO_API_SEND);
  await writeFile(prompt, '<tether-turn path="/tmp/doc.md" />');
  await writeFile(sdk, `import {writeFileSync} from 'node:fs';
export async function connectToDaemon() { return {
 fetchAgent: async id => ({agent:{id,status:process.env.API_BUSY==='1'?'running':'idle'}}),
 sendAgentMessage: async (agent,text,options) => writeFileSync(process.env.API_RESULT,JSON.stringify({agent,text,options})),
 close: async () => {}
}; }`);
  const invoke = async (busy: boolean) => {
    const child = Bun.spawn([process.execPath, script, sdk, f.root, "test-agent", "signal-123", prompt], {
      env: { ...process.env, API_RESULT: result, API_BUSY: busy ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output);
  };
  expect(await invoke(true)).toEqual({ busy: true });
  expect(await Bun.file(result).exists()).toBe(false);
  expect(await invoke(false)).toEqual({ accepted: true });
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ agent: "test-agent", text: '<tether-turn path="/tmp/doc.md" />', options: { messageId: "signal-123", activeTurnBehavior: "steer" } });
});
