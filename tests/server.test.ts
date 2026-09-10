import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { PrivateStore } from "../src/storage/private-store";
import { RecentsRegistry } from "../src/recents/registry";
import { bodyRevision } from "../src/core/annotation-ledger";
import { DocumentAccessError, DocumentService } from "../src/documents/document-service";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { controlRecentsAdd, controlRecentsLaunch } from "../src/server/lifecycle";
import type { RecentsSnapshot } from "../src/recents/service";
import type { HostAdapter, OpenLocalFileRequest, OpenViewRequest } from "../src/hosts/host-adapter";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];
const stores: PrivateStore[] = [];
function testRegistry(file: { config: ReturnType<typeof resolveConfig> }) { const store = new PrivateStore(join(file.config.configDir, "tether.sqlite")); stores.push(store); return new RecentsRegistry({ path: file.config.recentsPath, database: store.db }); }

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const store of stores.splice(0)) store.close();
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

function recentsUrl(daemon: TetherDaemon, location: string, pathname = ""): string {
  return new URL(pathname, `${daemon.origin}${location}`).href;
}

test("Folio help seeds a welcome document only through an authorized same-origin action", async () => {
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, opener: async () => {} });
  daemons.push(daemon);
  const session = await exchangeRecents(daemon, file.config);
  const url = recentsUrl(daemon, session.location, "api/welcome");
  expect((await fetch(url, { method: "POST", headers: { cookie: session.cookie, origin: "http://unrelated.invalid" } })).status).toBe(403);
  const options = { method: "POST", headers: { cookie: session.cookie, origin: daemon.origin } };
  const response = await fetch(url, options);
  expect(response.status).toBe(200);
  const result = await response.json() as { path: string };
  await writeFile(result.path, "My practice notes\n");
  expect((await fetch(url, options)).status).toBe(200);
  expect(await readFile(result.path, "utf8")).toBe("My practice notes\n");
});

async function exchangeRecents(daemon: TetherDaemon, config: ReturnType<typeof resolveConfig>) {
  await daemon.ready;
  const launch = await controlRecentsLaunch(config);
  const response = await fetch(launch.url, { redirect: "manual" });
  const location = response.headers.get("location")!;
  return { location, cookie: response.headers.get("set-cookie")!.split(";", 1)[0] };
}

test("Folio updates require a scoped cookie and same-origin installation or dismissal", async () => {
  const file = await fixture();
  const actions: string[] = [];
  const daemon = createDaemon({ config: file.config, updates: {
    status: async () => ({ available: { version: "0.2.0", tag: "v0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" }, installing: false, failed: false }),
    install: async tag => { actions.push(`install:${tag}`); }, dismiss: async tag => { actions.push(`dismiss:${tag}`); },
  } });
  daemons.push(daemon); await daemon.ready;
  const session = await exchangeRecents(daemon, file.config);
  const url = recentsUrl(daemon, session.location, "api/updates");
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { cookie: session.cookie } })).status).toBe(200);
  for (const action of ["install", "dismiss"]) {
    const options = { method: "POST", body: '{"tag":"v0.2.0"}', headers: { cookie: session.cookie, origin: "https://unrelated.invalid" } };
    expect((await fetch(`${url}/${action}`, options)).status).toBe(403);
    expect((await fetch(`${url}/${action}`, { ...options, headers: { ...options.headers, origin: daemon.origin } })).status).toBe(200);
  }
  expect(actions).toEqual(["install:v0.2.0", "dismiss:v0.2.0"]);
});

test("shutdown drains in-flight requests before closing the document store", async () => {
  const file = await fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const daemon = createDaemon({ config: file.config, web: async (_request, session) => {
    entered(); await blocked;
    return Response.json(await daemon.service.read(session.grant));
  } });
  daemons.push(daemon); await daemon.ready;
  const session = await exchange(daemon, file.path);
  const response = sessionFetch(daemon, session.location, session.cookie, "");
  await started;
  let closed = false;
  const closing = daemon.stop().then(() => { closed = true; });
  await Bun.sleep(10);
  expect(closed).toBe(false);
  release();
  expect((await response).status).toBe(200);
  await closing;
  expect(closed).toBe(true);
});

function sseSnapshots(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<RecentsSnapshot> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) return JSON.parse(data) as RecentsSnapshot;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before a snapshot arrived.");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
    reader,
  };
}

describe("browser launch authorization", () => {
  test("serves and authorizes every Recents context-menu action", async () => {
    const file = await fixture();
    const revealed: string[] = [];
    const opened: string[] = [];
    const trashed: string[] = [];
    const synchronized: string[][] = [];
    const host: HostAdapter = {
      id: "wave",
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
      openView: async () => {},
      openExternal: async (path) => { opened.push(path); },
      revealFile: async (path) => { revealed.push(path); },
      recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
    };
    const registry = testRegistry(file);
    await registry.add(file.path);
    await registry.add(file.other);
    const daemon = createDaemon({
      config: file.config,
      hostAdapter: host,
      trashFile: async (path) => { trashed.push(path); },
      startupGraceMs: 600_000,
      web: () => new Response("web"),
    });
    daemons.push(daemon);
    await daemon.ready;
    const launch = await controlRecentsLaunch(file.config, { host: "wave" });
    const exchanged = await fetch(launch.url, { redirect: "manual" });
    const location = exchanged.headers.get("location")!;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
    const action = (path: string, value: string) => fetch(recentsUrl(daemon, location, "api/action"), {
      method: "POST",
      headers: { cookie, origin: daemon.origin, "content-type": "application/json" },
      body: JSON.stringify({ path, action: value, confirmed: true }),
    });

    const page = await (await fetch(recentsUrl(daemon, location), { headers: { cookie } })).text();
    expect(page.includes("<title>Tether Folio</title>")).toBe(true);
    expect(page).toContain('rel="icon" type="image/png" href="/favicon.png"');
    const icon = await fetch(`${daemon.origin}/favicon.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from(await Bun.file("src/web/favicon.png").arrayBuffer()));
    expect(page).toContain("Reveal in Finder");
    expect(page.includes("Open in Default App")).toBe(true);
    expect(page.includes('data-action="archive">Archive</button>')).toBe(true);
    expect(page).toContain("Move to Trash");
    expect((await action(file.other, "reveal")).status).toBe(200);
    expect((await action(file.other, "default")).status).toBe(200);
    expect((await action(file.other, "remove")).status).toBe(200);
    expect((await action(file.path, "trash")).status).toBe(200);
    expect(revealed).toEqual([file.other]);
    expect(opened).toEqual([file.other]);
    expect(trashed).toEqual([file.path]);
    expect(await registry.paths()).toEqual([]);
    expect(synchronized.at(-1)).toEqual([]);
  });

  test("serves Folio Active/Archive and retention controls", async () => {
    const file = await fixture();
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000 });
    daemons.push(daemon); await daemon.ready;
    const session = await exchangeRecents(daemon, file.config);
    const page = await (await fetch(recentsUrl(daemon, session.location), { headers: { cookie: session.cookie } })).text();
    const dom = new JSDOM(page);
    expect(dom.window.document.title).toBe("Tether Folio");
    expect(dom.window.document.querySelector('[data-view="archive"]')).not.toBeNull();
    expect(dom.window.document.querySelector('#retention-mode')).not.toBeNull();
    expect(dom.window.document.querySelector('#package-input')).not.toBeNull();
    dom.window.close();
  });

  test("adds native-picker results through the scoped Recents session", async () => {
    const file = await fixture();
    const synchronized: string[][] = [];
    let pickerCalls = 0;
    const host: HostAdapter = {
      id: "wave",
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
      openView: async () => {},
      openExternal: async () => {},
      recentsChanged: async (entries) => { synchronized.push(entries.map((entry) => entry.path)); },
    };
    const registry = testRegistry(file);
    const daemon = createDaemon({
      config: file.config,
      hostAdapter: host,
      recents: registry,
      pickFiles: async () => pickerCalls++ === 0 ? [file.path, file.other] : [],
      startupGraceMs: 600_000,
      web: () => new Response("web"),
    });
    daemons.push(daemon);
    await daemon.ready;
    const launch = await controlRecentsLaunch(file.config, { host: "wave" });
    const exchanged = await fetch(launch.url, { redirect: "manual" });
    const location = exchanged.headers.get("location")!;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
    const pick = () => fetch(recentsUrl(daemon, location, "api/pick"), {
      method: "POST",
      headers: { cookie, origin: daemon.origin, "content-type": "application/json" },
      body: "{}",
    });

    const added = await pick();
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ cancelled: false, added: 2 });
    expect(await registry.paths()).toEqual([file.path, file.other]);
    expect(synchronized).toEqual([[file.path, file.other]]);
    expect(await (await pick()).json()).toEqual({ cancelled: true, added: 0 });
    expect(synchronized).toHaveLength(1);
  });

  test("rejects concurrent native picker requests", async () => {
    const file = await fixture();
    let releasePicker!: (paths: string[]) => void;
    const picker = new Promise<string[]>((resolve) => { releasePicker = resolve; });
    const daemon = createDaemon({ config: file.config, pickFiles: () => picker, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const launch = await controlRecentsLaunch(file.config);
    const exchanged = await fetch(launch.url, { redirect: "manual" });
    const location = exchanged.headers.get("location")!;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
    const request = () => fetch(recentsUrl(daemon, location, "api/pick"), {
      method: "POST",
      headers: { cookie, origin: daemon.origin, "content-type": "application/json" },
      body: "{}",
    });

    const first = request();
    await Bun.sleep(0);
    const second = await request();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "picker_busy" } });
    releasePicker([]);
    expect((await first).status).toBe(200);
  });

  test("awaits host recents synchronization and surfaces its failures", async () => {
    const file = await fixture();
    const host: HostAdapter = {
      id: "wave",
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
      openView: async () => {},
      openExternal: async () => {},
      recentsChanged: async () => { throw new Error("Wave update failed"); },
    };
    const daemon = createDaemon({ config: file.config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const grant = await daemon.service.open(file.path);
    const launch = daemon.mintTicket(grant, { host: "wave" });

    const response = await fetch(launch.url, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(daemon.sessions.size).toBe(1);
  });

  test("scopes the Recents page and opens only registered files in a new view", async () => {
    const file = await fixture();
    const opened: string[] = [];
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, opener: async (url) => { opened.push(url); }, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    await testRegistry(file).add(file.other);
    const launch = await controlRecentsLaunch(file.config);
    const exchange = await fetch(launch.url, { redirect: "manual" });
    const location = exchange.headers.get("location")!;
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];
    expect(location).toStartWith("/r/");
    expect(new URL(location, daemon.origin).searchParams.get("instance")).toBe(daemon.instanceId);
    expect((await fetch(recentsUrl(daemon, location, "api/files"), { headers: { cookie: "tether_recents=wrong" } })).status).toBe(401);
    const files = await (await fetch(recentsUrl(daemon, location, "api/files"), { headers: { cookie } })).json() as Array<{ path: string }>;
    expect(files.map((entry) => entry.path)).toEqual([file.other]);
    const openedRecent = await fetch(recentsUrl(daemon, location, "api/open"), {
      method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ path: file.other }),
    });
    expect(openedRecent.status).toBe(200);
    expect(opened).toHaveLength(1);
    expect((await fetch(opened[0], { redirect: "manual" })).status).toBe(302);
    const denied = await fetch(recentsUrl(daemon, location, "api/open"), {
      method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }),
    });
    expect(denied.status).toBe(403);
  });

  test("asks cmux to resolve the focused workspace for Recents document opens", async () => {
    const file = await fixture();
    const requests: OpenViewRequest[] = [];
    const nativeFiles: OpenLocalFileRequest[] = [];
    const host = {
      id: "cmux" as const,
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true }),
      openView: async (request: OpenViewRequest) => { requests.push(request); },
      openExternal: async () => {},
      openLocalFile: async (request: OpenLocalFileRequest) => { nativeFiles.push(request); },
    };
    const daemon = createDaemon({ config: file.config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    await testRegistry(file).add(file.other);
    const target = { host: "cmux", version: "0.64.22", build: "102", commit: "ddd4a01bc", windowId: "window", workspaceId: "workspace", surfaceId: "surface" };
    const launch = await controlRecentsLaunch(file.config, target);
    const exchange = await fetch(launch.url, { redirect: "manual" });
    const location = exchange.headers.get("location")!;
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];
    const opened = await fetch(recentsUrl(daemon, location, "api/open"), {
      method: "POST", headers: { cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify({ path: file.other }),
    });
    expect(opened.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "document", focus: true, targetPolicy: "focused-workspace", target });
    const reader = await fetch(requests[0]!.url, { redirect: "manual" });
    const readerLocation = reader.headers.get("location")!;
    const readerCookie = reader.headers.get("set-cookie")!.split(";", 1)[0];
    const link = (target: string) => sessionFetch(daemon, readerLocation, readerCookie, "api/open", {
      method: "POST", headers: { origin: daemon.origin }, body: JSON.stringify({ target, format: "markdown" }),
    });
    const linkedPath = join(file.directory, "newly linked.md");
    await writeFile(linkedPath, "Not previously in Folio");
    expect((await link("newly%20linked.md")).status).toBe(200);
    expect(requests[1]).toMatchObject({ kind: "document", targetPolicy: "source-pane", sourceUrl: `${daemon.origin}${readerLocation}` });
    const linkedReader = await fetch(requests[1]!.url, { redirect: "manual" });
    expect(linkedReader.status).toBe(302);
    expect(await testRegistry(file).paths()).toContain(await realpath(linkedPath));
    const transcript = join(file.directory, "transcript.txt");
    await writeFile(transcript, "Text");
    expect((await link("transcript.txt")).status).toBe(200);
    expect(nativeFiles).toEqual([{ path: await realpath(transcript), sourceUrl: `${daemon.origin}${readerLocation}`, target }]);
    expect(requests).toHaveLength(2);
    expect((await sessionFetch(daemon, readerLocation, readerCookie, "api/file")).status).toBe(200);

  });

  test("authenticates revisioned Recents snapshots and event streams", async () => {
    const file = await fixture();
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchangeRecents(daemon, file.config);

    expect((await fetch(recentsUrl(daemon, session.location, "api/snapshot"), { headers: { cookie: "tether_recents=wrong" } })).status).toBe(401);
    expect((await fetch(recentsUrl(daemon, session.location, "api/events"), { headers: { cookie: "tether_recents=wrong" } })).status).toBe(401);
    const snapshot = await (await fetch(recentsUrl(daemon, session.location, "api/snapshot"), { headers: { cookie: session.cookie } })).json() as RecentsSnapshot;
    expect(snapshot).toMatchObject({ sequence: expect.any(Number), files: [], retention: { mode: "forever" } });
  });

  test("pushes committed Recents changes to every session and closes streams on cancel and stop", async () => {
    const file = await fixture();
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const firstSession = await exchangeRecents(daemon, file.config);
    const secondSession = await exchangeRecents(daemon, file.config);
    const firstResponse = await fetch(recentsUrl(daemon, firstSession.location, "api/events"), { headers: { cookie: firstSession.cookie } });
    const secondResponse = await fetch(recentsUrl(daemon, secondSession.location, "api/events"), { headers: { cookie: secondSession.cookie } });
    expect(firstResponse.headers.get("content-type")).toContain("text/event-stream");
    const firstEvents = sseSnapshots(firstResponse);
    const secondEvents = sseSnapshots(secondResponse);
    const firstInitial = await firstEvents.next();
    const secondInitial = await secondEvents.next();
    expect(firstInitial.files).toEqual([]);
    expect(secondInitial.sequence).toBeGreaterThan(firstInitial.sequence);

    const added = await controlRecentsAdd(file.config, file.path);
    expect(added).toMatchObject({ path: file.path, recentCount: 1, hostSynchronized: false });
    const [firstAdded, secondAdded] = await Promise.all([firstEvents.next(), secondEvents.next()]);
    expect(firstAdded.sequence).toBe(secondAdded.sequence);
    expect(firstAdded.files.map((entry) => entry.path)).toEqual([file.path]);

    await firstEvents.cancel();
    await exchange(daemon, file.other);
    const opened = await secondEvents.next();
    expect(opened.files.map((entry) => entry.path)).toEqual([file.other, file.path]);

    const removed = await fetch(recentsUrl(daemon, secondSession.location, "api/action"), {
      method: "POST",
      headers: { cookie: secondSession.cookie, origin: daemon.origin, "content-type": "application/json" },
      body: JSON.stringify({ path: file.path, action: "remove" }),
    });
    expect(removed.status).toBe(200);
    expect((await secondEvents.next()).files.filter((entry: any) => entry.view === "active").map((entry) => entry.path)).toEqual([file.other]);

    await Promise.race([daemon.stop(), Bun.sleep(1_000).then(() => { throw new Error("daemon stop waited on an SSE stream"); })]);
    await expect(secondEvents.reader.read()).resolves.toMatchObject({ done: true });
  });

  test("publishes a control add before reporting host synchronization failure", async () => {
    const file = await fixture();
    const host: HostAdapter = {
      id: "wave",
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: true, widgetInstallation: true, fileNavigatorHook: false, revealFile: true }),
      openView: async () => {},
      openExternal: async () => {},
      recentsChanged: async () => { throw new Error("Wave update failed"); },
    };
    const daemon = createDaemon({ config: file.config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchangeRecents(daemon, file.config);
    const response = await fetch(recentsUrl(daemon, session.location, "api/events"), { headers: { cookie: session.cookie } });
    const events = sseSnapshots(response);
    await events.next();

    expect(await controlRecentsAdd(file.config, file.path, { host: "wave" })).toMatchObject({ hostSynchronized: false });
    expect((await events.next()).files.map((entry) => entry.path)).toEqual([file.path]);
    await events.cancel();
  });

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
    await testRegistry(file).add(file.other);
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

  test("opens wikilinks in a new view, persists preferences, and survives reload release", async () => {
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
    // Cross at least one 500 ms sweeper tick. Reload must not depend on racing
    // the release beacon against the replacement page's bootstrap request.
    await Bun.sleep(750);
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/bootstrap")).status).toBe(200);
    expect((await sessionFetch(daemon, session.location, session.cookie, "api/lease", { method: "POST", headers: origin, body: JSON.stringify({ clientId: "replacement-page" }) })).status).toBe(200);
    expect(daemon.sessions.size).toBe(2);
  });
});

test("browser sessions survive expired presence leases", async () => {
  const file = await fixture();
  let now = 1_700_000_000_000;
  const daemon = createDaemon({
    config: file.config,
    now: () => now,
    leaseMs: 10,
    startupGraceMs: 0,
    idleMs: 0,
    web: () => new Response("web"),
  });
  daemons.push(daemon);
  await daemon.ready;
  const session = await exchange(daemon, file.path);
  const origin = { origin: daemon.origin };
  expect((await sessionFetch(daemon, session.location, session.cookie, "api/lease", {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ clientId: "suspended-browser" }),
  })).status).toBe(200);

  now += 20;
  await Bun.sleep(600);
  now += 6_000;
  await Bun.sleep(600);

  expect(daemon.sessions.size).toBe(1);
  expect((await sessionFetch(daemon, session.location, session.cookie, "api/bootstrap")).status).toBe(200);
});

test("Recents sessions survive expired presence leases", async () => {
  const file = await fixture();
  let now = 1_700_000_000_000;
  const daemon = createDaemon({
    config: file.config,
    now: () => now,
    leaseMs: 10,
    startupGraceMs: 0,
    idleMs: 0,
    web: () => new Response("web"),
  });
  daemons.push(daemon);
  await daemon.ready;
  const launch = await controlRecentsLaunch(file.config);
  const exchange = await fetch(launch.url, { redirect: "manual" });
  const location = exchange.headers.get("location")!;
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];

  now += 20;
  await Bun.sleep(600);

  expect((await fetch(recentsUrl(daemon, location, "api/files"), { headers: { cookie } })).status).toBe(200);
});

test("idle shutdown resolves the daemon closed promise", async () => {
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, startupGraceMs: 0, idleMs: 0, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  await Promise.race([daemon.closed, Bun.sleep(2_000).then(() => { throw new Error("daemon did not stop"); })]);
});

test('custom theme writes serialize across views, survive reload, and reject invalid changes atomically', async () => {
  const { tetherDesign } = await import('../src/shared/themes');
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000 });
  daemons.push(daemon); await daemon.ready;
  const a = await exchange(daemon, file.path), b = await exchange(daemon, file.other);
  const put = (session: typeof a, body: unknown) => sessionFetch(daemon, session.location, session.cookie, 'api/preferences', { method: 'PUT', headers: { origin: daemon.origin }, body: JSON.stringify(body) });
  const themes = ['one', 'two'].map(id => ({ ...tetherDesign(true), id: `custom-${id}`, name: id }));
  const results = await Promise.all([put(a, { saveTheme: themes[0] }), put(b, { saveTheme: themes[1] })]);
  expect(results.map(r => r.status)).toEqual([200, 200]);
  expect((await put(a, { theme: 'custom-one' })).status).toBe(200);
  const before = await readFile(file.config.preferencesPath, 'utf8');
  expect(JSON.parse(before).customThemes).toHaveLength(2);
  expect((await put(a, { saveTheme: { ...themes[0], metrics: { bodySize: 500 } } })).status).toBe(400);
  expect(await readFile(file.config.preferencesPath, 'utf8')).toBe(before);
  const bootstrap = await (await sessionFetch(daemon, b.location, b.cookie, 'api/bootstrap')).json() as { preferences: { theme: string; customThemes: unknown[] } };
  expect(bootstrap.preferences.theme).toBe('custom-one'); expect(bootstrap.preferences.customThemes).toHaveLength(2);
});

test('reader tab icons load without webview cookies while document resources remain protected', async () => {
  const { createWebBundleResponder } = await import('../src/web/bundle');
  const respond = await createWebBundleResponder();
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, web: request => respond(request) });
  daemons.push(daemon); await daemon.ready;
  const session = await exchange(daemon, file.path);
  const page = await (await sessionFetch(daemon, session.location, session.cookie, '')).text();
  const iconHref = /<link[^>]*rel="icon"[^>]*href="([^\"]+)"/.exec(page)![1];
  const iconUrl = new URL(iconHref, `${daemon.origin}${session.location}`);
  expect(iconUrl.pathname).toBe('/favicon.png');
  // Mirrors cmux's native URLSession request, which has no WKWebView session cookie.
  const icon = await fetch(iconUrl);
  expect(icon.status).toBe(200);
  expect(icon.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from(await Bun.file('src/web/favicon.png').arrayBuffer()));
  const privateScript = /src="(\.\/[^\"]+\.js)"/.exec(page)![1];
  expect((await fetch(new URL(privateScript, `${daemon.origin}${session.location}`))).status).toBe(401);
  expect((await fetch(new URL('api/bootstrap', `${daemon.origin}${session.location}`))).status).toBe(401);
});

test("local links reveal non-Markdown files without creating document sessions", async () => {
  const file = await fixture();
  const transcript = join(file.directory, "transcript with spaces.txt");
  await writeFile(transcript, "Plain text");
  const revealed: string[] = [];
  const opened: string[] = [];
  let revealAvailable = true;
  const host: HostAdapter = {
    id: "browser", detect: async () => true,
    capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: revealAvailable }),
    openView: async ({ url }) => { opened.push(url); },
    openExternal: async () => { throw new Error("Unexpected external open"); },
    revealFile: async (path) => { revealed.push(path); },
  };
  const daemon = createDaemon({ config: file.config, hostAdapter: host, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const session = await exchange(daemon, file.path);
  const open = (target: string, format: "markdown" | "wikilink") => sessionFetch(daemon, session.location, session.cookie, "api/open", {
    method: "POST", headers: { origin: daemon.origin }, body: JSON.stringify({ target, format }),
  });
  expect((await open("./transcript%20with%20spaces.txt", "markdown")).status).toBe(200);
  expect((await open("transcript with spaces.txt|Transcript", "wikilink")).status).toBe(200);
  expect(revealed).toEqual([await realpath(transcript), await realpath(transcript)]);
  expect(opened).toHaveLength(0);
  expect(daemon.sessions.size).toBe(1);
  expect((await open("missing.txt", "markdown")).status).not.toBe(200);
  revealAvailable = false;
  const unavailable = await open("transcript with spaces.txt", "markdown");
  expect(unavailable.status).not.toBe(200);
  expect(await unavailable.text()).toContain("unavailable");
  expect(revealed).toHaveLength(2);
  expect((await open("./other.md", "markdown")).status).toBe(200);
  expect(opened).toHaveLength(1);
  expect((await sessionFetch(daemon, session.location, session.cookie, "api/file")).status).toBe(200);
});
