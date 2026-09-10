import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { controlRequest } from "../src/server/lifecycle";
import { bodyRevision } from "../src/core/index";

const roots: string[] = [], daemons: TetherDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/tether-cli-audit-")); roots.push(root);
  const path = join(root, "source.md"); await writeFile(path, "# Title\n\nFirst repeated phrase.\n\nSecond repeated phrase.\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(root, "runtime"), configDir: join(root, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600000 }); daemons.push(daemon); await daemon.ready;
  const cli = async (args: string[], body = "Comment body") => {
    const result = await runCli(args, { config, readBody: async () => body });
    if (!result.response.ok) throw new Error(JSON.stringify(result.response));
    return result.response.data as any;
  };
  return { root, path, config, daemon, cli };
}

test("CLI quote candidates, editing, bounded reads and moving preserve one conversation", async () => {
  const f = await fixture(); const candidates = await f.cli(["quote-candidates", f.path, "--quote", "repeated phrase"]);
  expect(candidates.candidates).toHaveLength(2);
  const comment = await f.cli(["comment", f.path, "--actor", "assistant", "--quote", "repeated phrase", "--candidate-id", candidates.candidates[1].candidateId, "--expected-body-revision", candidates.bodyRevision, "--operation-id", "comment", "--body-file", "-"]);
  const threadId = comment.mutation.appliedEventId;
  expect((await f.cli(["event", f.path, threadId])).event.id).toBe(threadId);
  const reply = await f.cli(["reply", f.path, threadId, "--actor", "assistant", "--operation-id", "reply", "--body-file", "-"]);
  await f.cli(["edit", f.path, threadId, reply.mutation.appliedEventId, "--actor", "assistant", "--operation-id", "edit", "--expected-thread-sequence", "2", "--body-file", "-"], "Edited reply");
  const page = await f.cli(["thread", f.path, threadId, "--limit", "1", "--max-bytes", "2048"]);
  expect(page.messages).toHaveLength(1); expect(page.continuation).toBeTruthy();
  const next = await f.cli(["thread", f.path, threadId, "--limit", "1", "--continuation", page.continuation]);
  expect(next.messages[0].body).toBe("Edited reply");
  await f.cli(["delete", f.path, threadId, reply.mutation.appliedEventId, "--actor", "assistant", "--operation-id", "delete", "--expected-thread-sequence", "3"]);
  expect((await f.cli(["thread", f.path, threadId])).messages).toHaveLength(1);
  expect((await f.cli(["operation", f.path, "--operation-id", "edit"])).outcome).toBe("applied");
  const outline = await f.cli(["document", "outline", f.path]); expect(outline.headings[0].title).toBe("Title");
  expect((await f.cli(["document", "context", f.path, threadId])).anchorStatus).toBe("located");
  await writeFile(f.path, "# Changed title\n\nSecond repeated phrase.\n");
  expect((await f.cli(["document", "diff", f.path, "--from-revision", outline.bodyRevision])).status).toBe("changed");
  const target = join(f.root, "moved.md"); const move = await f.cli(["document", "move", f.path, target]);
  expect(move.path).toBe(target); expect((await f.cli(["thread", target, threadId])).thread.id).toBe(threadId);
  expect(await Bun.file(f.path).exists()).toBe(false);
  expect((await f.cli(["folio", "list", "--open-threads"])).files.some((file: any) => file.path === target)).toBe(true);
  expect((await f.cli(["folio", "sync"])).hostSyncStatus).toBe("unsupported");
});

test("comment preconditions and invalid revision inputs fail before mutation", async () => {
  const f = await fixture(); const args = ["comment", f.path, "--actor", "assistant", "--quote", "Title", "--body-file", "-", "--operation-id", "stale", "--expected-body-revision", bodyRevision("Old")];
  expect((await runCli(args, { config: f.config, readBody: async () => "Body" })).response).toMatchObject({ ok: false, error: { code: "conflict" } });
  const invalid = await runCli(["document", "diff", f.path, "--from-revision", "x".repeat(8192)], { config: f.config });
  expect(invalid.exitCode).toBe(2);
  await expect(controlRequest(f.config, "/control/document/diff", { path: f.path, fromRevision: "x".repeat(8192), maxBytes: 2048 })).rejects.toMatchObject({ code: "invalid_request" });
});

test("partial import keeps complete outcomes when a prior imported file is missing", async () => {
  const f = await fixture(); const directory = join(f.root, "imports"); await mkdir(directory);
  const value = { format: "tether-review", version: 1, documents: [{ name: "one.md", body: "One", threads: [] }, { name: "two.md", body: "Two", threads: [] }] };
  await writeFile(join(directory, "two.md"), "Occupied");
  const first = await controlRequest<any>(f.config, "/control/folio/import", { package: value, directory });
  expect(first.outcome).toBe("partially_applied"); expect(first.completed).toHaveLength(1); expect(first.failed).toHaveLength(1);
  expect(await readFile(join(directory, "two.md"), "utf8")).toBe("Occupied");
  await unlink(join(directory, "one.md")); await unlink(join(directory, "two.md"));
  const retry = await controlRequest<any>(f.config, "/control/folio/import", { package: value, directory });
  expect(retry.outcome).toBe("applied"); expect(retry.completed).toHaveLength(2); expect(retry.completed[0].replayed).toBe(true);
  expect(await Bun.file(join(directory, "one.md")).exists()).toBe(false);
  expect(await readFile(join(directory, "two.md"), "utf8")).toBe("Two");
});
