import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";

async function fixture() {
  const directory = await mkdtemp("/tmp/tether-create-"), path = join(directory, "new.md"), source = join(directory, "body.txt");
  await writeFile(source, "# Garden planner\n\nA new document.\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
  const cli = async (args: string[], session: string | null = "creator") => (await runCli(args, { config, env: session ? { PASEO_AGENT_ID: session, TETHER_PASEO_HOST_ID: "host" } : {} })).response as any;
  const create = (extra: string[] = [], session: string | null = "creator", destination = path) => cli(["document", "create", destination, "--body-file", source, ...extra], session);
  return { directory, path, source, daemon, cli, create, lease: () => daemon.hostTurns.lease("local", "host", "plugin"),
    async close() { await daemon.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test("creation returns an assigned creator, default identity and Folio entry without a Go press", async () => {
  const f = await fixture();
  try {
    f.lease(); const result = await f.create();
    expect(result.ok).toBe(true); expect(result.data.outcome).toBe("applied");
    expect(result.data.go.registered).toBe(true);
    expect(result.data.identity.name).toBe("Garden planner");
    expect(result.data.identity.icon).toBeTruthy(); expect(result.data.identity.colorSlot).toBeGreaterThan(0);
    expect(result.data.context.document.body).toBe(await readFile(f.source, "utf8"));
    const subscriptions = f.daemon.hostTurns.subscriptions();
    expect(subscriptions).toHaveLength(1); expect(subscriptions[0]?.recipientId).toBe("paseo:creator");
    expect(f.daemon.hostTurns.snapshot("local", "host").signals).toHaveLength(0);
    const folio = await f.cli(["folio", "list"]);
    expect(folio.data.files.some((entry: any) => entry.documentId === result.data.documentId || entry.id === result.data.documentId)).toBe(true);
  } finally { await f.close(); }
});

test("creation preserves an existing role's name, icon and color after takeover", async () => {
  const f = await fixture();
  try {
    f.lease(); const first = await f.create(["--name", "Garden builder", "--icon", "flame"], "old");
    const role = first.data.identity.id;
    const takeover = await f.cli(["turn", "takeover", f.path, "--role-id", role, "--expected-recipient", "paseo:old"]);
    expect(takeover.ok).toBe(true);
    const second = await f.create(["--name", "Ignored new name"], "creator", join(f.directory, "second.md"));
    expect(second.data.identity).toEqual(first.data.identity);
    expect(f.daemon.hostTurns.subscriptions().map(s => s.agentId)).toEqual([role, role]);
    expect(f.daemon.hostTurns.subscriptions().every(s => s.recipientId === "paseo:creator")).toBe(true);
  } finally { await f.close(); }
});

test("different creators get unique default names and separate rotated identities", async () => {
  const f = await fixture();
  try {
    f.lease(); const a = await f.create();
    const b = await f.create([], "other", join(f.directory, "other.md"));
    expect(b.data.identity.name).toBe("Garden planner 2");
    expect(b.data.identity.icon).not.toBe(a.data.identity.icon);
    expect(b.data.identity.colorSlot).not.toBe(a.data.identity.colorSlot);
  } finally { await f.close(); }
});

test("creation refuses an unavailable host before publishing a file", async () => {
  const f = await fixture();
  try {
    expect((await f.create()).error.code).toBe("turn_host_unavailable");
    expect(await Bun.file(f.path).exists()).toBe(false);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
  } finally { await f.close(); }
});

test("existing files, symlinks and retained Tether records are never claimed as creations", async () => {
  const f = await fixture();
  try {
    f.lease(); await writeFile(f.path, "existing\n");
    expect((await f.create()).error.code).toBe("document_exists");
    expect(await readFile(f.path, "utf8")).toBe("existing\n");
    await unlink(f.path); await symlink(f.source, f.path);
    expect((await f.create()).error.code).toBe("document_exists");
    await unlink(f.path); await writeFile(f.path, "registered\n");
    await f.cli(["recents", "add", f.path]);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
    await unlink(f.path);
    expect((await f.create()).error.code).toBe("document_exists");
    expect(await Bun.file(f.path).exists()).toBe(false);
  } finally { await f.close(); }
});

test("concurrent creators publish one complete document and register only its creator", async () => {
  const f = await fixture();
  try {
    f.lease(); const results = await Promise.all([f.create([], "a"), f.create([], "b")]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok).error.code).toBe("document_exists");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(1);
    expect(await readFile(f.path, "utf8")).toBe(await readFile(f.source, "utf8"));
  } finally { await f.close(); }
});

test("partial setup preserves the file and returns a resumable assignment command", async () => {
  const f = await fixture();
  try {
    f.lease(); const partial = await f.create(["--icon", "not-an-icon"]);
    expect(partial.ok).toBe(true); expect(partial.data.created).toBe(true);
    expect(partial.data.outcome).toBe("partially_applied"); expect(partial.data.go.registered).toBe(false);
    expect(partial.data.resume.slice(0, 2)).toEqual(["turn", "assign"]);
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
    const resumed = await f.cli(["turn", "assign", partial.data.handoff, "--icon", "flame"]);
    expect(resumed.ok).toBe(true); expect(resumed.data.identity.icon).toBe("flame");
    expect((await f.create()).error.code).toBe("document_exists");
    expect(await readFile(f.path, "utf8")).toBe(await readFile(f.source, "utf8"));
  } finally { await f.close(); }
});

test("a non-Paseo creator gets a document with explicit unassigned Go status", async () => {
  const f = await fixture();
  try {
    const result = await f.create([], null);
    expect(result.ok).toBe(true); expect(result.data.go.registered).toBe(false);
    expect(result.data.go.reason).toContain("Paseo");
    expect(f.daemon.hostTurns.subscriptions()).toHaveLength(0);
    await expect(f.daemon.library.dispatch("document.create", { path: join(f.directory, "remote.md"), body: "no" })).rejects.toThrow("local profile");
    expect(await Bun.file(join(f.directory, "remote.md")).exists()).toBe(false);
  } finally { await f.close(); }
});
