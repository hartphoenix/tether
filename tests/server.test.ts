import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
    status: async () => ({ managed: true, agentSkillReviewNeeded: false, checkFailed: false, prolongedFailure: false, unavailableReason: null, checkError: null, version: "0.1.0", available: { version: "0.2.0", tag: "v0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" }, installing: false, failed: false }),
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

function sseSnapshots<T = RecentsSnapshot>(response: Response, eventName = "snapshot") {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<T> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data && block.split("\n").includes(`event: ${eventName}`)) return JSON.parse(data) as T;
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

  test("serves bundled branding for the favicon and documentation banners", async () => {
    const file = await fixture("Welcome\n");
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000 });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchange(daemon, file.path);
    for (const path of ["assets/tether-banner.png", "docs/assets/tether-banner.png", "assets/tether-banner-tagline.png", "docs/assets/tether-banner-tagline.png"]) {
      const response = await sessionFetch(daemon, session.location, session.cookie, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(`docs/assets/${path.split("/").at(-1)}`));
    }
    const icon = await fetch(`${daemon.origin}/favicon.png`);
    expect(icon.status).toBe(200);
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(await readFile("docs/assets/tether-logo.png"));
  });

  test("opens wikilinks in a new view, persists preferences, and survives reload release", async () => {
    const file = await fixture("[[other]]\n");
    const opened: string[] = [];
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, opener: async (url) => { opened.push(url); }, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const session = await exchange(daemon, file.path);
    const origin = { origin: daemon.origin };

    const preference = await sessionFetch(daemon, session.location, session.cookie, "api/preferences", { method: "PUT", headers: origin, body: JSON.stringify({ theme: "tether" }) });
    expect(preference.status).toBe(200);
    expect((await (await sessionFetch(daemon, session.location, session.cookie, "api/bootstrap")).json() as { preferences: { theme: string } }).preferences.theme).toBe("tether");

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

test("filter bank requires scoped same-origin access and survives daemon replacement", async () => {
  const file = await fixture();
  let daemon = createDaemon({ config: file.config, opener: async () => {} });
  daemons.push(daemon);
  let session = await exchangeRecents(daemon, file.config);
  const url = recentsUrl(daemon, session.location, "api/filters");
  const change = (body: unknown, origin = daemon.origin, cookie = session.cookie) => fetch(url, {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await change({ action: "save", text: "notes" }, "https://example.com")).status).toBe(403);
  expect((await change({ action: "save", text: "notes" }, daemon.origin, "tether_recents=wrong")).status).toBe(401);
  for (const body of [{ action: "save", text: " " }, { action: "toggle", text: "notes" }, { action: "set-active", text: "notes", active: "yes" }, { action: "save", text: "x".repeat(1001) }]) {
    expect((await change(body)).status).toBe(400);
  }
  const saved = await (await change({ action: "save", text: " Notes " })).json();
  expect(saved.filters).toEqual([{ text: "Notes", active: true }]);
  await Promise.all([change({ action: "save", text: "red" }), change({ action: "save", text: "blue" })]);
  const duplicate = await (await change({ action: "save", text: "NOTES" })).json();
  expect(duplicate.filters).toHaveLength(3);
  await change({ action: "set-active", text: "notes", active: false });
  await change({ action: "delete", text: "blue" });
  await daemon.stop();
  daemons.splice(daemons.indexOf(daemon), 1);
  daemon = createDaemon({ config: file.config, opener: async () => {} });
  daemons.push(daemon);
  session = await exchangeRecents(daemon, file.config);
  const restored = await (await fetch(recentsUrl(daemon, session.location, "api/snapshot"), { headers: { cookie: session.cookie } })).json();
  expect(restored.filters).toEqual([{ text: "Notes", active: false }, { text: "red", active: true }]);
});

test("Folio reports redirected parent paths and archives the original records", async () => {
  const file = await fixture();
  const parent = join(file.directory, "original"), moved = join(file.directory, "moved");
  await mkdir(parent);
  const path = join(await realpath(parent), "transcript.md"); await writeFile(path, "Transcript\n");
  const daemon = createDaemon({ config: file.config, opener: async () => {} }); daemons.push(daemon); await daemon.ready;
  await controlRecentsAdd(file.config, path);
  const session = await exchangeRecents(daemon, file.config);
  const post = (endpoint: string, body: object) => fetch(recentsUrl(daemon, session.location, `api/${endpoint}`), { method: "POST", headers: { cookie: session.cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  await rename(parent, moved); await symlink(moved, parent);
  for (const action of ["open", "reveal", "default", "trash", "export"]) {
    const response = await post(action === "open" ? "open" : "action", { path, action, confirmed: true });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe("folio_path_changed");
  }
  const archive = await post("action", { path, action: "archive" });
  expect(archive.status).toBe(200);
  expect((await archive.json() as any).outcomes).toEqual([{ path, outcome: "changed" }]);
  expect((await (await post("action", { path, action: "archive" })).json() as any).outcomes).toEqual([{ path, outcome: "unchanged" }]);
  const removal = await post("action", { path, action: "remove-entry" });
  expect(removal.status).toBe(200);
  expect((await removal.json() as any).deleted).toEqual([path]);
  expect(await readFile(join(moved, "transcript.md"), "utf8")).toBe("Transcript\n");
  expect((await post("action", { path, action: "archive" })).status).not.toBe(200);
});

test("Folio protects conversation history, locates stale records and reports mixed batch outcomes", async () => {
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, opener: async () => {} }); daemons.push(daemon); await daemon.ready;
  await controlRecentsAdd(file.config, file.path); await controlRecentsAdd(file.config, file.other);
  const store = daemon.service.store;
  const entry = store.documentForPath(file.path)!;
  store.db.query("INSERT INTO annotation_events(document_id,seq,id,type,actor,created_at,payload_json) VALUES (?,?,?,?,?,?,?)").run(entry.id, 1, "comment", "comment", "human", "2026-01-01", "{}");
  const session = await exchangeRecents(daemon, file.config);
  const post = (endpoint: string, body: object) => fetch(recentsUrl(daemon, session.location, `api/${endpoint}`), { method: "POST", headers: { cookie: session.cookie, origin: daemon.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const target = join(file.directory, "relocated.md"); await rename(file.path, target); await symlink(target, file.path);
  expect((await post("action", { path: file.path, action: "remove-entry" })).status).toBe(409);
  expect((await post("action", { path: file.path, action: "locate", target: file.other })).status).not.toBe(200);
  const located = await post("action", { path: file.path, action: "locate", target });
  expect(located.status).toBe(200);
  expect((await located.json() as any).id).toBe(entry.id);
  expect(store.documentForPath(await realpath(target))?.id).toBe(entry.id);
  expect(store.db.query("SELECT count(*) AS count FROM annotation_events WHERE document_id=?").get(entry.id)).toEqual({ count: 1 });
  await unlink(file.other);
  const batch = await post("batch", { paths: [file.other, join(file.directory, "unknown.md")], action: "archive" });
  const result = await batch.json() as any;
  expect(result.completed).toEqual([file.other]); expect(result.failed).toHaveLength(1);
  const missing = await post("open", { path: file.other });
  expect((await missing.json() as any).error.code).toBe("folio_file_missing");
});


test("Folio theme events follow committed saves and reconnect with the current palette", async () => {
  const { tetherDesign } = await import("../src/shared/themes");
  const { folioTheme } = await import("../src/web/folio-page");
  const file = await fixture();
  const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000 });
  daemons.push(daemon); await daemon.ready;
  const reader = await exchange(daemon, file.path);
  const folio = await exchangeRecents(daemon, file.config);
  const connect = async () => sseSnapshots<ReturnType<typeof folioTheme>>(
    await fetch(recentsUrl(daemon, folio.location, "api/events"), { headers: { cookie: folio.cookie } }), "theme");
  const put = (body: unknown) => sessionFetch(daemon, reader.location, reader.cookie, "api/preferences", {
    method: "PUT", headers: { origin: daemon.origin }, body: JSON.stringify(body),
  });
  const events = await connect();
  expect(await events.next()).toEqual(folioTheme());
  expect((await put({ theme: "tether" })).status).toBe(200);
  expect(await events.next()).toEqual(folioTheme({ theme: "tether" }));
  const theme = { ...tetherDesign(true), id: "custom-live", name: "Live" };
  expect((await put({ theme: theme.id, saveTheme: theme })).status).toBe(200);
  expect(await events.next()).toEqual(folioTheme({ design: theme }));
  const edited = { ...theme, colors: { ...theme.colors, background: "#123456" } };
  expect((await put({ saveTheme: edited })).status).toBe(200);
  expect(await events.next()).toEqual(folioTheme({ design: edited }));
  expect((await put({ saveTheme: { ...theme, metrics: { bodySize: 500 } } })).status).toBe(400);
  await events.cancel();
  const reconnected = await connect();
  expect(await reconnected.next()).toEqual(folioTheme({ design: edited }));
  await reconnected.cancel();
});

test("reader and Folio skill reviews require scoped access and same-origin decisions", async () => {
  const { installAgentSkill, updateAgentSkills, readAgentSkillReview, listAgentSkillReviews } = await import("../src/cli/agent-skills");
  const file = await fixture(), root = join(file.directory, "package");
  const source = join(root, "integrations/agents/tether-review/SKILL.md");
  await mkdir(join(root, "integrations/agents/tether-review"), { recursive: true });
  await writeFile(source, "Original bundle");
  const installed = await installAgentSkill(join(file.directory, "skills"), file.config, root);
  await writeFile(installed.path, "Personal instructions"); await writeFile(source, "Updated bundle");
  await updateAgentSkills(file.config, root);
  const daemon = createDaemon({ config: file.config, opener: async () => {} }); daemons.push(daemon); await daemon.ready;
  const reader = await exchange(daemon, file.path), folio = await exchangeRecents(daemon, file.config);
  const [entry] = await listAgentSkillReviews(file.config);
  for (const view of [reader, folio]) {
    const url = new URL("api/updates/skills", `${daemon.origin}${view.location}`);
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { cookie: view.cookie } });
    expect(await response.json()).toEqual([{ id: entry!.id, path: installed.path }]);
    for (const suffix of ["read", "decide"]) {
      expect((await fetch(`${url}/${suffix}`, { method: "POST", headers: { cookie: view.cookie, origin: "https://unrelated.invalid" }, body: JSON.stringify({ id: entry!.id }) })).status).toBe(403);
    }
    const read = await fetch(`${url}/read`, { method: "POST", headers: { cookie: view.cookie, origin: daemon.origin }, body: JSON.stringify({ id: entry!.id }) });
    expect((await read.json() as { current: string }).current).toBe("Personal instructions");
    expect((await fetch(`${url}/decide`, { method: "POST", headers: { cookie: view.cookie, origin: daemon.origin }, body: JSON.stringify({ id: entry!.id, revision: "stale", action: "replace" }) })).status).toBe(409);
  }
  const review = await readAgentSkillReview(file.config, entry!.id);
  const response = await fetch(new URL("api/updates/skills/decide", `${daemon.origin}${folio.location}`), {
    method: "POST", headers: { cookie: folio.cookie, origin: daemon.origin }, body: JSON.stringify({ id: entry!.id, revision: review.revision, action: "replace" }),
  });
  expect(response.status).toBe(200);
  expect(await readFile(installed.path, "utf8")).toBe("Updated bundle");
  expect(await listAgentSkillReviews(file.config)).toEqual([]);
});
