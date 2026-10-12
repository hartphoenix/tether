import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { installAgentSkill } from "../src/cli/agent-skills";

const roots: string[] = [], daemons: TetherDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tether-default-")); roots.push(root);
  const path = join(root, "review.md"); await writeFile(path, "# Review\n\nA unique passage to discuss.\n");
  const config = resolveConfig({ profile: "default-test", configDir: join(root, "config"), runtimeDir: join(root, "runtime") });
  const daemon = createDaemon({ config, startupGraceMs: 600000 }); daemons.push(daemon); await daemon.ready;
  const run = (args: string[], body = "A question") => runCli(args, { config, readBody: async () => body });
  const call = async (args: string[], body?: string) => {
    const result = await run(args, body);
    if (!result.response.ok) throw new Error(JSON.stringify(result.response));
    return result.response.data as any;
  };
  const comment = (id: string, body?: string) => call(["comment", path, "--actor", "hart", "--quote", "unique passage", "--body-file", "-", "--operation-id", id], body);
  return { root, path, config, run, call, comment };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("ordinary help is focused and invalid arguments cause no body read", async () => {
  const help = await runCli(["--help"]);
  expect(help.response).toMatchObject({ protocol: 1, ok: true, data: { commands: expect.arrayContaining(["pending", "document", "paseo", "cmux", "wave"]) } });
  expect(bytes(help.response)).toBeLessThan(1500);
  const focused = await runCli(["reply", "--help"]);
  expect(focused.response).toMatchObject({ data: { command: "reply", usage: expect.stringContaining("--operation-id") } });
  expect(focused.response).not.toHaveProperty("data.reporting");
  expect((await runCli(["setup", "--help"])).response).toHaveProperty("data.agentSetup");
  expect((await runCli(["document", "--help"])).response).toHaveProperty("data.commands");
  let reads = 0;
  for (const args of [["reply", "--help", "--unexpected"], ["--compact", "--help"], ["pending", "file", "--compact", "--actor", "assistant"]]) {
    expect((await runCli(args, { readBody: async () => { reads++; return ""; } })).exitCode).toBe(2);
  }
  expect(reads).toBe(0);
});

test("ordinary writes retain safe receipts, replay, conflicts, and file safety", async () => {
  const f = await fixture(), original = await readFile(f.path, "utf8");
  const seeded = await f.comment("seed"); const id = seeded.mutation.appliedEventId;
  const pending = await f.call(["pending", f.path, "--actor", "assistant"]);
  expect(pending).toMatchObject({ acknowledgedBodyRevision: null, reviewState: "never_reviewed", events: [{ id, threadId: id, type: "comment" }] });
  expect(pending).not.toHaveProperty("documentId"); expect(pending.events[0]).not.toHaveProperty("body");
  const thread = await f.call(["thread", f.path, id]);
  expect(thread.thread).toEqual({ id, status: "open", sequence: 1 });
  expect(thread.messages[0].body).toBe("A question");
  const args = ["reply", f.path, id, "--actor", "assistant", "--body-file", "-", "--operation-id", "reply", "--expected-thread-sequence", "1"];
  const reply = await f.call(args, "An answer");
  expect(Object.keys(reply)).toEqual(["mutation"]);
  expect(reply.mutation).toEqual({ operationId: "reply", appliedEventId: expect.any(String), appliedSequence: 2, replayed: false });
  expect(await f.call(args, "An answer")).toMatchObject({ mutation: { appliedSequence: 2, replayed: true } });
  expect(await f.call(["operation", f.path, "--operation-id", "reply"])).toEqual({ operationId: "reply", outcome: "applied", receipt: reply.mutation });
  expect(await f.call(["operation", f.path, "--operation-id", "missing"])).toEqual({ operationId: "missing", outcome: "outcome_unknown", receipt: null });
  const stale = ["resolve", f.path, id, "--actor", "assistant", "--operation-id", "stale", "--expected-thread-sequence", "1"];
  expect((await f.run(stale)).response).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect((await f.call(["thread", f.path, id])).thread.status).toBe("open");
  await f.call(["resolve", f.path, id, "--actor", "assistant", "--operation-id", "resolve", "--expected-thread-sequence", "2"]);
  expect(await f.call(args, "An answer")).toEqual({ mutation: { ...reply.mutation, replayed: true } });
  expect((await f.call(["thread", f.path, id])).thread).toEqual({ id, status: "resolved", sequence: 3 });
  expect(await readFile(f.path, "utf8")).toBe(original);
  const read = await f.call(["document", "read", f.path]);
  const saved = await f.call(["document", "save", f.path, "--expected-body-revision", read.bodyRevision, "--body-file", "-"], "New body\n");
  expect(Object.keys(saved).sort()).toEqual(["bodyRevision", "path"]);
  expect((await f.run(["document", "save", f.path, "--expected-body-revision", read.bodyRevision, "--body-file", "-"], "Stale overwrite")).response).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await readFile(f.path, "utf8")).toBe("New body\n");
  expect(await f.call(["pending", f.path, "--actor", "assistant"])).toHaveProperty("events.0.id", id);
});

test("the distributed single-file skill installs without extra resources", async () => {
  const f = await fixture();
  const result = await installAgentSkill(join(f.root, "skills"), f.config);
  expect(await readFile(result.path, "utf8")).toBe(await readFile("integrations/agents/tether-review/SKILL.md", "utf8"));
});

async function reviewCycle(passage: boolean, count: number) {
  const f = await fixture();
  const initial = await f.call(["pending", f.path, "--actor", "assistant"]);
  await f.call(["document", "read", f.path]);
  await f.call(["acknowledge", f.path, "--actor", "assistant", "--cursor", initial.cursor, "--operation-id", "baseline"]);
  for (let i = 0; i < count; i++) await f.comment(`seed-${i}`, `Question ${i}. ` + "Please consider this detail. ".repeat(20));
  let total = 0, calls = 0;
  const measured = async (args: string[], text?: string) => {
    const result = await f.run(args, text);
    if (!result.response.ok) throw new Error(JSON.stringify(result.response));
    total += bytes(result.response); calls++;
    return result.response.data as any;
  };
  const pending = await measured(["pending", f.path, "--actor", "assistant"]);
  for (const event of pending.events) {
    const id = event.threadId ?? event.id;
    const thread = await measured(["thread", f.path, id]);
    // Include passage context in workflows that need it; the index does not carry anchors.
    if (passage) await measured(["document", "context", f.path, id]);
    await measured(["reply", f.path, id, "--actor", "assistant", "--operation-id", `answer-${id}`, "--expected-thread-sequence", String(thread.thread.sequence), "--body-file", "-"], "Handled; ready for your review.");
  }
  await measured(["acknowledge", f.path, "--actor", "assistant", "--cursor", pending.cursor, "--operation-id", "reviewed"]);
  expect((await f.call(["pending", f.path, "--actor", "assistant"])).events).toEqual([]);
  expect(await readFile(f.path, "utf8")).toBe("# Review\n\nA unique passage to discuss.\n");
  return { bytes: total, calls };
}

test("ordinary review cycles stay below recorded verbose baselines including context-call costs", async () => {
  // Baselines from the same fixtures before lean defaults, not a second runtime mode.
  for (const [name, passage, count, baselineBytes, baselineCalls] of [
    ["ordinary-eight", false, 8, 23369, 18], ["passage-eight", true, 8, 23369, 18],
    ["short-one", false, 1, 3762, 4], ["empty", false, 0, 965, 2],
  ] as const) {
    const result = await reviewCycle(passage, count);
    expect(result.bytes).toBeLessThan(baselineBytes * 0.7);
    expect(result.calls).toBe(baselineCalls + (passage ? count : 0));
    console.log(JSON.stringify({ scenario: name, baselineBytes, ...result, reductionPercent: Math.round(100 * (1 - result.bytes / baselineBytes)) }));
  }
});

test("ordinary thread pages preserve lossless fragments and the current edited message", async () => {
  const f = await fixture();
  const seeded = await f.comment("long-seed", "Original"); const id = seeded.mutation.appliedEventId;
  const text = '😀 \\"\n'.repeat(3000);
  await f.call(["edit", f.path, id, id, "--actor", "hart", "--operation-id", "long-edit", "--expected-thread-sequence", "1", "--body-file", "-"], text);
  let continuation: string | undefined, joined = "", pages = 0;
  do {
    const page = await f.call(["thread", f.path, id, "--max-bytes", "2048", ...(continuation ? ["--continuation", continuation] : [])]);
    expect(bytes(page)).toBeLessThanOrEqual(2048);
    expect(page.thread).toEqual({ id, status: "open", sequence: 2 });
    const fragment = page.messages[0].fragment;
    expect(fragment.offset).toBe(joined.length); joined += fragment.text;
    continuation = page.continuation ?? undefined;
    expect(++pages).toBeLessThan(200);
  } while (continuation);
  expect(JSON.parse(joined)).toMatchObject({ id, body: text, actor: "hart" });
});
