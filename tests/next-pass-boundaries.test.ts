import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, type TetherDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { controlLaunch } from "../src/server/lifecycle";
import { runCli } from "../src/cli/main";

test("usage correction includes the recognized command without echoing unknown arguments", async () => {
  const result = await runCli(["document", "context", "file.md", "--start-line", "private-value"]);
  expect(result.exitCode).toBe(2);
  expect(JSON.stringify(result.response)).toContain("mdreview document context <file> <thread-id>");
  expect(JSON.stringify(result.response)).not.toContain("private-value");
  expect(JSON.stringify(result.response)).not.toContain("--start-line");
});

test("HTTP authority and referrer policy hold; occupied saved ports preserve scoped drafts without contacting the occupant", async () => {
  const dir = await mkdtemp("/tmp/tether-boundary-");
  let daemon: TetherDaemon | undefined;
  let occupant: ReturnType<typeof Bun.serve> | undefined;
  try {
    const config = resolveConfig({ profile: "test", runtimeDir: join(dir, "runtime"), configDir: join(dir, "config") });
    const path = join(dir, "doc.md"); await writeFile(path, "# Unchanged\n");
    daemon = await startDaemon({ config, web: () => new Response("reader") });
    const grant = await daemon.service.open(path);
    const launch = await fetch(daemon.mintTicket(grant).url, { redirect: "manual" });
    const route = launch.headers.get("location")!;
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(daemon.origin + route, { headers: { cookie } });
    expect(page.status).toBe(200); expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await fetch(daemon.origin + route, { headers: { cookie, host: "unexpected.invalid" } })).status).toBe(403);
    expect((await fetch(daemon.origin + route)).status).toBe(401);
    const revision = (await daemon.service.read(grant)).bodyRevision;
    expect((await fetch(daemon.origin + route + "api/draft", { method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ body: "Unsaved", baseRevision: revision, scroll: 55 }) })).status).toBe(200);
    const port = daemon.port;
    await daemon.stop(); daemon = undefined;
    let contacts = 0;
    occupant = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => { contacts++; return Response.json({ service: "tether", protocol: 1 }); } });
    daemon = await startDaemon({ config, web: () => new Response("reader") });
    expect(daemon.port).not.toBe(port);
    const restored = await fetch(daemon.origin + route + "api/bootstrap", { headers: { cookie } });
    expect(restored.status).toBe(200);
    expect((await restored.json() as any).draft.body).toBe("Unsaved");
    expect(contacts).toBe(0);
    const viewId = route.split("/")[2]!;
    const other = join(dir, "other.md"); await writeFile(other, "Other");
    await expect(controlLaunch(config, other, undefined, viewId)).rejects.toThrow();
    const resume = await controlLaunch(config, path, undefined, viewId);
    const resumed = await fetch(resume.url, { redirect: "manual" });
    expect(resumed.headers.get("location")).toBe(route);
    const renewedCookie = resumed.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(daemon.origin + route + "api/bootstrap", { headers: { cookie } })).status).toBe(401);
    const recovered = await (await fetch(daemon.origin + route + "api/bootstrap", { headers: { cookie: renewedCookie } })).json() as any;
    expect(recovered.draft).toMatchObject({ body: "Unsaved", baseRevision: revision, scroll: 55 });
    expect((await fetch(resume.url, { redirect: "manual" })).status).toBe(401);

    expect((await fetch(daemon.origin + route + "api/draft", { method: "POST", headers: { cookie: renewedCookie, origin: "http://unexpected.invalid" } })).status).toBe(403);
    await expect(startDaemon({ config, port, web: () => new Response("reader") })).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally { await daemon?.stop(); occupant?.stop(true); await rm(dir, { recursive: true, force: true }); }
});
