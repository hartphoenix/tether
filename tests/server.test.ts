import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyRevision } from "../src/core/annotation-ledger";
import { DocumentAccessError, DocumentService } from "../src/documents/document-service";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(source = "Original body\n") {
  const directory = await mkdtemp(join("/tmp", "tether-server-"));
  directories.push(directory);
  const path = join(directory, "document.md");
  const other = join(directory, "other.md");
  await writeFile(path, source);
  await writeFile(other, "Other body\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  return { directory, path: await realpath(path), other: await realpath(other), config };
}

async function exchange(daemon: TetherDaemon, path: string) {
  const grant = await daemon.service.open(path);
  const launch = daemon.mintTicket(grant);
  const response = await fetch(launch.url, { redirect: "manual" });
  const location = response.headers.get("location")!;
  const setCookie = response.headers.get("set-cookie")!;
  return { grant, launch, response, location, cookie: setCookie.split(";", 1)[0], setCookie };
}

function sessionFetch(daemon: TetherDaemon, location: string, cookie: string, pathname: string, init: RequestInit = {}) {
  return fetch(new URL(pathname.replace(/^\//, ""), `${daemon.origin}${location}`).href, {
    ...init,
    headers: { cookie, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
}

describe("browser launch authorization", () => {
  test("uses expiring single-use tickets and distinct path-scoped cookie sessions", async () => {
    const file = await fixture();
    let now = 1_700_000_000_000;
    const daemon = createDaemon({ config: file.config, now: () => now, ticketMs: 10, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;

    const expiredGrant = await daemon.service.open(file.path);
    const expired = daemon.mintTicket(expiredGrant);
    now += 11;
    const expiredResponse = await fetch(expired.url, { redirect: "manual" });
    expect(expiredResponse.status).toBe(401);
    expect((await expiredResponse.json() as { error: { code: string } }).error.code).toBe("ticket_expired");
    await expect(daemon.service.read(expiredGrant)).rejects.toBeInstanceOf(DocumentAccessError);

    const first = await exchange(daemon, file.path);
    expect(first.response.status).toBe(302);
    expect(first.location).not.toContain("ticket");
    expect(first.setCookie).toContain(`Path=${first.location}`);
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Strict");
    expect((await fetch(first.launch.url, { redirect: "manual" })).status).toBe(401);

    const second = await exchange(daemon, file.path);
    expect(second.location).not.toBe(first.location);
    expect(second.cookie).not.toBe(first.cookie);
    expect((await sessionFetch(daemon, first.location, "tether_session=wrong", "api/bootstrap")).status).toBe(401);
    const bootstrap = await sessionFetch(daemon, first.location, first.cookie, "api/bootstrap");
    expect(bootstrap.status).toBe(200);
    expect((await bootstrap.json() as { document: { path: string; body: string } }).document).toMatchObject({ path: file.path, body: "Original body\n" });
  });

  test("never treats Recents or a browser path value as authority", async () => {
    const file = await fixture();
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    await new (await import("../src/recents/registry")).RecentsRegistry(file.config.recentsPath).add(file.other);
    const session = await exchange(daemon, file.path);

    const response = await sessionFetch(daemon, session.location, session.cookie, `api/file?path=${encodeURIComponent(file.other)}`);
    expect(response.status).toBe(200);
    expect((await response.json() as { path: string; body: string })).toMatchObject({ path: file.path, body: "Original body\n" });

    const attempted = await sessionFetch(daemon, session.location, session.cookie, "api/file", {
      method: "PUT",
      headers: { origin: daemon.origin },
      body: JSON.stringify({ path: file.other, content: "Changed granted file\n", expectedBodyRevision: bodyRevision("Original body\n") }),
    });
    expect(attempted.status).toBe(200);
    expect(await readFile(file.path, "utf8")).toBe("Changed granted file\n");
    expect(await readFile(file.other, "utf8")).toBe("Other body\n");
  });
});

describe("session API", () => {
  test("serves annotations and exact export from one document source read", async () => {
    const file = await fixture("One source snapshot\n");
    let reads = 0;
    const service = new DocumentService({
      readText: async (path) => {
        reads += 1;
        return await readFile(path, "utf8");
      },
    });
    const daemon = createDaemon({ config: file.config, service, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchange(daemon, file.path);

    reads = 0;
    const annotations = await sessionFetch(daemon, session.location, session.cookie, "api/annotations?actor=assistant");
    expect(annotations.status).toBe(200);
    const payload = await annotations.json() as { bodyRevision: string; ledgerRevision: string; annotations: { events: unknown[] } };
    expect(reads).toBe(1);
    expect(payload.bodyRevision).toBe(bodyRevision("One source snapshot\n"));
    expect(payload.annotations.events).toEqual([]);

    reads = 0;
    const exported = await sessionFetch(daemon, session.location, session.cookie, "api/export");
    expect(exported.status).toBe(200);
    expect(await exported.text()).toBe("One source snapshot\n");
    expect(reads).toBe(1);
  });

  test("requires same origin for mutations and preserves concurrent review events", async () => {
    const file = await fixture("Concurrent target\n");
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchange(daemon, file.path);
    const initial = await (await sessionFetch(daemon, session.location, session.cookie, "api/file")).json() as { bodyRevision: string };
    const payload = (body: string) => JSON.stringify({
      type: "comment", actor: "hart", body, expectedBodyRevision: initial.bodyRevision,
      anchor: { exact: "Concurrent", prefix: "", suffix: " target", projectionStart: 0, projectionEnd: 10, bodyRevision: initial.bodyRevision },
    });
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/annotations", { method: "POST", body: payload("missing origin") })).status).toBe(403);
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/annotations", { method: "POST", headers: { origin: "http://evil.invalid" }, body: payload("wrong origin") })).status).toBe(403);
    const results = await Promise.all(["First", "Second"].map((body) => sessionFetch(daemon, session.location, session.cookie, "api/annotations", {
      method: "POST", headers: { origin: daemon.origin }, body: payload(body),
    })));
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const final = await (await sessionFetch(daemon, session.location, session.cookie, "api/file")).json() as { annotations: { events: Array<{ seq: number }> } };
    expect(final.annotations.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("opens wikilinks in a new view, persists preferences, and releases leases", async () => {
    const file = await fixture("[[other]]\n");
    const opened: string[] = [];
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, opener: async (url) => { opened.push(url); }, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchange(daemon, file.path);
    const origin = { origin: daemon.origin };

    const preference = await sessionFetch(daemon, session.location, session.cookie, "api/preferences", { method: "PUT", headers: origin, body: JSON.stringify({ theme: "nord" }) });
    expect(preference.status).toBe(200);
    expect((await (await sessionFetch(daemon, session.location, session.cookie, "api/bootstrap")).json() as { preferences: { theme: string } }).preferences.theme).toBe("nord");

    const open = await sessionFetch(daemon, session.location, session.cookie, "api/open", { method: "POST", headers: origin, body: JSON.stringify({ target: "other" }) });
    expect(open.status).toBe(200);
    expect(opened).toHaveLength(1);
    const linked = await fetch(opened[0], { redirect: "manual" });
    expect(linked.status).toBe(302);
    const original = await (await sessionFetch(daemon, session.location, session.cookie, "api/file")).json() as { path: string };
    expect(original.path).toBe(file.path);

    expect((await sessionFetch(daemon, session.location, session.cookie, "api/lease", { method: "POST", headers: origin, body: JSON.stringify({ clientId: "browser" }) })).status).toBe(200);
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/release", { method: "POST", headers: origin, body: JSON.stringify({ clientId: "browser" }) })).status).toBe(200);
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/file")).status).toBe(401);
  });
});

test("idle shutdown resolves the daemon closed promise", async () => {
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, startupGraceMs: 0, idleMs: 0, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  await Promise.race([daemon.closed, Bun.sleep(2_000).then(() => { throw new Error("daemon did not stop"); })]);
});
