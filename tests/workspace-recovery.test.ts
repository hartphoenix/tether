import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { recoveryRoute, recoveryScript } from "../src/hosts/recovery";
import { resolveConfig } from "../src/server/config";
import { startDaemon, type TetherDaemon } from "../src/server/server";
import { controlRequest, controlRecentsLaunch } from "../src/server/lifecycle";
import { runCli } from "../src/cli/main";
import { createCmuxHost } from "../src/hosts/cmux";

const directories: string[] = [], daemons: TetherDaemon[] = [];
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(); for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp("/tmp/tether-workspace-"); directories.push(directory);
  const config = resolveConfig({ runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const path = join(directory, "document.md"); await writeFile(path, "# Recovery\n");
  return { directory, config, path: await realpath(path) };
}

test("recovery inventory retains view identity without registration or new authority", async () => {
  const f = await fixture(); let daemon = await startDaemon({ config: f.config, web: () => new Response("reader") }); daemons.push(daemon);
  const exchange = await fetch(daemon.mintTicket(await daemon.service.open(f.path)).url, { redirect: "manual" });
  const route = exchange.headers.get("location")!, cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const id = recoveryRoute(daemon.origin + route)!.id;
  const folio = await controlRecentsLaunch(f.config); await fetch(folio.url, { redirect: "manual" });
  const before = daemon.service.store.db.query("SELECT * FROM documents").all();
  await daemon.stop(); daemon = await startDaemon({ config: f.config, web: () => new Response("reader") }); daemons.push(daemon);
  const inventory = await controlRequest<any>(f.config, "/control/recovery/views", {}, { start: false });
  expect(inventory.views.find((v: any) => v.id === id)).toEqual({ id, kind: "document", url: daemon.origin + route });
  expect(JSON.stringify(inventory)).not.toContain(f.path);
  expect(JSON.stringify(inventory)).not.toContain(cookie);
  expect(daemon.service.store.db.query("SELECT * FROM documents").all()).toEqual(before);
  expect((await fetch(daemon.origin + route)).status).toBe(401);
  expect((await fetch(daemon.origin + route, { headers: { cookie } })).status).toBe(200);
});

test("inspection of a stopped service creates no database or daemon", async () => {
  const f = await fixture();
  const host = { id: "cmux" as const, detect: async () => true, capabilities: () => ({} as any), openView: async () => {}, openExternal: async () => {}, recoverViews: async () => { throw new Error("must not run"); } };
  const result = await runCli(["resume", "--inspect"], { config: f.config, host });
  expect(result.response).toMatchObject({ ok: false, error: { code: "daemon_unavailable" } });
  expect(await Bun.file(join(f.config.configDir, "tether.sqlite")).exists()).toBe(false);
  expect(await Bun.file(f.config.discoveryPath).exists()).toBe(false);
});

test("atomic page repair protects mounted, loading, navigated and unknown pages", () => {
  const source = "http://127.0.0.1:1234/s/reader/", destination = "http://127.0.0.1:5678/s/reader/";
  for (const [patch, reason] of [
    [{ mounted: true }, "mounted"], [{ ready: "loading" }, "loading"], [{ href: "https://example.com" }, "location_changed"],
    [{ contentType: "text/html" }, "unknown_page"], [{ body: '{"error":{"code":"anything"}}' }, "unknown_page"],
  ] as const) {
    const base = { mounted: false as boolean, ready: "complete" as string, href: source, contentType: "application/json" as string, body: '{"error":{"code":"unauthorized"}}' };
    const state = { ...base, ...patch };
    let navigations = 0;
    const context = { URL, location: { href: state.href, replace: () => { navigations++; } }, document: { readyState: state.ready, contentType: state.contentType, querySelector: () => state.mounted, body: { textContent: state.body } } };
    expect(runInNewContext(recoveryScript(source, destination, false), context)).toBe(reason);
    expect(navigations).toBe(0);
  }
});

test("page repair uses existing route once and never renews missing authorization", () => {
  const source = "http://127.0.0.1:1234/s/reader/", destination = "http://127.0.0.1:5678/s/reader/";
  const navigations: string[] = [];
  const context = { URL, location: { href: source, replace: (url: string) => navigations.push(url) }, document: { readyState: "complete", contentType: "application/json", querySelector: () => null, body: { textContent: '{"error":{"code":"unauthorized"}}' } } };
  expect(runInNewContext(recoveryScript(source, source, false), context)).toBe("authorization_required");
  expect(runInNewContext(recoveryScript(source, destination, true), context)).toBe("eligible");
  expect(navigations).toEqual([]);
  expect(runInNewContext(recoveryScript(source, destination, false), context)).toBe("navigated");
  expect(runInNewContext(recoveryScript(source, destination, false), context)).toBe("navigation_pending");
  expect(navigations).toEqual([destination]);
});

test("host recovery rejects duplicate view IDs and never creates or focuses a surface", async () => {
  const windowId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const old = "http://127.0.0.1:1234/s/reader/";
  const commands: string[][] = [];
  const host = createCmuxHost({ run: async command => {
    commands.push(command);
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({ windows: [{ id: windowId, workspaces: [{ id: workspaceId, panes: [{ surfaces: [1, 2].map(() => ({ id: crypto.randomUUID(), type: "browser", url: old })) }] }] }] }) };
  } });
  const result = await host.recoverViews([{ id: "reader", kind: "document", url: "http://127.0.0.1:5678/s/reader/" }]);
  expect(result.results.map(r => r.reason)).toEqual(["duplicate_view", "duplicate_view"]);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("tree");
});

test("host recovery reads cmux eval value and reports the exact repaired view", async () => {
  const windowId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), surfaceId = crypto.randomUUID();
  const commands: string[][] = [];
  const host = createCmuxHost({ run: async command => {
    commands.push(command);
    const payload = command.includes("tree")
      ? { windows: [{ id: windowId, workspaces: [{ id: workspaceId, panes: [{ surfaces: [{ id: surfaceId, type: "browser", url: "http://127.0.0.1:1234/s/reader/" }] }] }] }] }
      : { value: "navigated" };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(payload) };
  } });
  const report = await host.recoverViews([{ id: "reader", kind: "document", url: "http://127.0.0.1:5678/s/reader/" }]);
  expect(report.results).toEqual([{ surfaceId, viewId: "reader", status: "navigated", reason: "navigated" }]);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toContain("eval");
  expect(commands[1]).toContain(surfaceId);
});

test("host recovery reloads a unique Tether pane whose page cannot be inspected", async () => {
  const windowId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), surfaceId = crypto.randomUUID();
  const commands: string[][] = [];
  const host = createCmuxHost({ run: async command => {
    commands.push(command);
    if (command.includes("tree")) return { exitCode: 0, stderr: "", stdout: JSON.stringify({ windows: [{ id: windowId, workspaces: [{ id: workspaceId, panes: [{ surfaces: [{ id: surfaceId, type: "browser", url: "http://127.0.0.1:1234/r/folio/?instance=old#tether-chromeless" }] }] }] }] }) };
    if (command.includes("eval")) return { exitCode: 1, stderr: "page not scriptable", stdout: "" };
    return { exitCode: 0, stderr: "", stdout: "{}" };
  } });
  const views = [{ id: "folio", kind: "folio" as const, url: "http://127.0.0.1:1234/r/folio/?instance=new" }];
  expect((await host.recoverViews(views, true)).results[0]).toMatchObject({ status: "eligible" });
  expect(commands.some(command => command.includes("navigate"))).toBe(false);
  const report = await host.recoverViews(views);
  expect(report.results).toEqual([{ surfaceId, viewId: "folio", status: "navigated", reason: "navigated" }]);
  const navigation = commands.find(command => command.includes("navigate"))!;
  expect(navigation).toContain(surfaceId);
  expect(navigation.at(-1)).toBe("http://127.0.0.1:1234/r/folio/?instance=new#tether-chromeless");
});
