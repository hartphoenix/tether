import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision, splitAnnotationLedger } from "../src/core/annotation-ledger";
import { DocumentAccessError } from "../src/documents/document-service";
import { runCli } from "../src/cli/main";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("returns one versioned open result without exposing the launch ticket", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, "Example\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const opened: string[] = [];
  const result = await runCli(["open", path], { config, open: async (url) => { opened.push(url); } });
  expect(result.exitCode).toBe(0);
  expect(result.response).toEqual({
    protocol: 1,
    ok: true,
    command: "open",
    data: { path: await realpath(path), expiresAt: expect.any(Number), opened: true },
  });
  expect(JSON.stringify(result.response)).not.toContain("ticket");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("/launch?ticket=");
});

test("uses a documented structured usage failure", async () => {
  const result = await runCli(["unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.response).toMatchObject({ protocol: 1, ok: false, command: "unknown", error: { code: "usage" } });
});

test("requires control authentication and closes each command's temporary grant", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-control-"));
  directories.push(directory);
  const path = join(directory, "private.md");
  await writeFile(path, "Private document\n");
  const config = resolveConfig({ profile: "control", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const unauthorized = await fetch(`${daemon.origin}/control/document/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  expect(unauthorized.status).toBe(403);
  expect(await unauthorized.json()).toMatchObject({ error: { code: "forbidden" } });

  expect((await runCli(["document", "read", path], { config })).exitCode).toBe(0);
  await expect(daemon.service.read(await realpath(path))).rejects.toBeInstanceOf(DocumentAccessError);
});

test("runs the complete agent document and thread workflow through a reused daemon", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-cli-"));
  directories.push(directory);
  const path = join(directory, "review.md");
  await writeFile(path, "Review target\n");
  const config = resolveConfig({ profile: "agent", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const seedGrant = await daemon.service.open(path);
  const initial = await daemon.service.read(seedGrant);
  const seeded = await daemon.service.appendComment({
    session: seedGrant,
    actor: "hart",
    expectedBodyRevision: initial.bodyRevision,
    body: "Please revise and explain.",
    anchor: { exact: "Review", prefix: "", suffix: " target", projectionStart: 0, projectionEnd: 6, bodyRevision: initial.bodyRevision },
  });
  daemon.service.close(seedGrant);
  const threadId = (seeded.annotations.events[0] as { id: string }).id;

  // Keep a browser session open while the CLI mutates the same canonical file.
  const browserGrant = await daemon.service.open(path);
  const launch = daemon.mintTicket(browserGrant);
  const exchange = await fetch(launch.url, { redirect: "manual" });
  const location = exchange.headers.get("location")!;
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];

  const read = await runCli(["document", "read", path], { config });
  expect(read.exitCode).toBe(0);
  expect(read.response).toMatchObject({ protocol: 1, ok: true, command: "document.read", data: { body: "Review target\n", bodyRevision: initial.bodyRevision } });

  const pending = await runCli(["pending", path, "--actor", "assistant"], { config });
  expect(pending.response).toMatchObject({ ok: true, command: "review.pending", data: { events: [{ id: threadId, type: "comment" }], maxSequence: 1 } });
  expect(JSON.stringify(pending.response)).not.toContain('"thread"');
  expect(JSON.stringify(pending.response)).not.toContain("Review target");

  expect((await runCli(["thread", path, threadId], { config })).response).toMatchObject({ ok: true, command: "review.thread", data: { thread: { id: threadId, status: "open" } } });
  expect((await runCli(["reply", path, threadId, "--actor", "assistant", "--body-file", "-"], { config, readBody: async () => "Applied the requested revision.\nSecond line." })).response).toMatchObject({ ok: true, command: "review.reply", data: { maxSequence: 2 } });
  expect((await runCli(["resolve", path, threadId, "--actor", "assistant"], { config })).response).toMatchObject({ ok: true, command: "review.resolve", data: { maxSequence: 3, unresolvedCount: 0 } });
  const reopened = await runCli(["reopen", path, threadId, "--actor", "assistant"], { config });
  expect(reopened.response).toMatchObject({ ok: true, command: "review.reopen", data: { maxSequence: 4, unresolvedCount: 1 } });

  const ledgerBeforeSave = splitAnnotationLedger(await readFile(path, "utf8")).ledgerText;
  const saved = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], {
    config,
    readBody: async () => "Revised by agent.\n\nMultiline body.\n",
  });
  expect(saved.response).toMatchObject({ ok: true, command: "document.save", data: { bodyRevision: bodyRevision("Revised by agent.\n\nMultiline body.\n"), ledgerRevision: expect.any(String) } });
  expect(splitAnnotationLedger(await readFile(path, "utf8")).ledgerText).toBe(ledgerBeforeSave);
  const ledgerAfterSave = splitAnnotationLedger(await readFile(path, "utf8")).ledgerText;
  expect(ledgerAfterSave).toContain("Applied the requested revision.");

  const browserRead = await fetch(`${daemon.origin}${location}api/file`, { headers: { cookie } });
  expect((await browserRead.json() as { body: string }).body).toBe("Revised by agent.\n\nMultiline body.\n");

  const savedRevision = bodyRevision("Revised by agent.\n\nMultiline body.\n");
  expect((await runCli(["acknowledge", path, "--actor", "assistant", "--through", "4", "--body-revision", savedRevision], { config })).response).toMatchObject({ ok: true, command: "review.acknowledge", data: { maxSequence: 5 } });
  expect((await runCli(["pending", path, "--actor", "assistant"], { config })).response).toMatchObject({ ok: true, data: { events: [] } });

  const conflict = await runCli(["document", "save", path, "--expected-body-revision", initial.bodyRevision, "--body-file", "-"], { config, readBody: async () => "Stale overwrite\n" });
  expect(conflict).toMatchObject({ exitCode: 1, response: { ok: false, command: "document.save", error: { code: "conflict" } } });
  const missing = await runCli(["document", "read", join(directory, "missing.md")], { config });
  expect(missing).toMatchObject({ exitCode: 1, response: { error: { code: "document_not_found" } } });
  const invalidThread = await runCli(["thread", path, "missing-thread"], { config });
  expect(invalidThread).toMatchObject({ exitCode: 1, response: { error: { code: "thread_not_found" } } });
});

test("reports a malformed ledger as read-only and refuses agent saves", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-agent-malformed-"));
  directories.push(directory);
  const path = join(directory, "broken.md");
  await writeFile(path, "Body\n<!-- wave-annotations:v1\nnot-json\n-->\n");
  const config = resolveConfig({ profile: "broken", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;

  const read = await runCli(["document", "read", path], { config });
  expect(read.response).toMatchObject({ ok: true, data: { body: "Body\n", readOnly: true, ledgerError: expect.any(String) } });
  const revision = (read.response as { data: { bodyRevision: string } }).data.bodyRevision;
  const save = await runCli(["document", "save", path, "--expected-body-revision", revision, "--body-file", "-"], { config, readBody: async () => "Replacement\n" });
  expect(save).toMatchObject({ exitCode: 1, response: { error: { code: "ledger_invalid" } } });
});
