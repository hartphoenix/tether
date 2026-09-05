import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { bodyRevision } from "../src/core/annotation-ledger";
import { DocumentAccessError, DocumentService } from "../src/documents/document-service";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import { controlRecentsLaunch } from "../src/server/lifecycle";
import type { HostAdapter, OpenViewRequest } from "../src/hosts/host-adapter";

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

function recentsUrl(daemon: TetherDaemon, location: string, pathname = ""): string {
  return new URL(pathname, `${daemon.origin}${location}`).href;
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
    const registry = new (await import("../src/recents/registry")).RecentsRegistry(file.config.recentsPath);
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
      body: JSON.stringify({ path, action: value }),
    });

    const page = await (await fetch(recentsUrl(daemon, location), { headers: { cookie } })).text();
    expect(page).toContain("<title>Recents</title>");
    expect(page).toContain("Reveal in Finder");
    expect(page).toContain("Open in Default App");
    expect(page).toContain("Remove from Queue");
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

  test("renders responsive Recents filtering, timed status, and confirmed batch selection actions", async () => {
    const file = await fixture();
    const daemon = createDaemon({ config: file.config, pickFiles: async () => [], startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    const launch = await controlRecentsLaunch(file.config);
    const exchanged = await fetch(launch.url, { redirect: "manual" });
    const location = exchanged.headers.get("location")!;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
    const page = await (await fetch(recentsUrl(daemon, location), { headers: { cookie } })).text();
    const today = new Date();
    today.setSeconds(0, 0);
    const older = new Date(2020, 0, 2, 23, 59);
    const files = [
      { path: "/Users/alice/Documents/Projects/alpha.md", directory: "/Users/alice/Documents/Projects", name: "alpha.md", createdAt: today.getTime() },
      { path: "/Users/alice/Documents/beta.md", directory: "/Users/alice/Documents", name: "beta.md", createdAt: older.getTime() },
    ];
    const actionRequests: Array<{ path: string; action: string }> = [];
    let pickerRequests = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const dom = new JSDOM(page, { runScripts: "outside-only", url: recentsUrl(daemon, location) });
    Object.defineProperty(dom.window, "fetch", { value: async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/files")) return Response.json(files);
      if (String(input).endsWith("/action")) actionRequests.push(JSON.parse(String(init?.body)));
      if (String(input).endsWith("/pick")) { pickerRequests++; return Response.json({ cancelled: false, added: 2 }); }
      return Response.json({ ok: true });
    } });
    Object.defineProperty(dom.window, "setInterval", { value: () => 0 });
    Object.defineProperty(dom.window, "setTimeout", { value: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; } });
    Object.defineProperty(dom.window, "clearTimeout", { value: (id: number) => { timers.delete(id); } });
    dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
    await Bun.sleep(0);

    const input = dom.window.document.querySelector<HTMLInputElement>("#filter")!;
    expect(input.placeholder).toBe("filter by filename");
    expect(dom.window.document.querySelector("h1")).toBeNull();
    expect([...dom.window.document.querySelectorAll(".dir")].map((node) => node.textContent)).toEqual(["~/Documents/Projects", "~/Documents"]);
    expect([...dom.window.document.querySelectorAll(".dir bdi")].every((node) => node.getAttribute("dir") === "ltr")).toBe(true);
    expect([...dom.window.document.querySelectorAll(".time")].map((node) => node.textContent)).toEqual([
      `${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}`,
      "1/2",
    ]);
    expect(page).toContain("text-overflow:ellipsis;direction:rtl;text-align:left");

    input.value = "BETA";
    input.dispatchEvent(new dom.window.Event("input"));
    expect([...dom.window.document.querySelectorAll(".name")].map((node) => node.textContent)).toEqual(["beta.md"]);

    input.value = "";
    input.dispatchEvent(new dom.window.Event("input"));
    const add = dom.window.document.querySelector<HTMLButtonElement>("#add")!;
    const select = dom.window.document.querySelector<HTMLButtonElement>("#select")!;
    const remove = dom.window.document.querySelector<HTMLButtonElement>("#batch-remove")!;
    const trash = dom.window.document.querySelector<HTMLButtonElement>("#batch-trash")!;
    expect(add.textContent).toBe("+");
    expect(add.hidden).toBe(false);
    add.click();
    await Bun.sleep(0);
    expect(pickerRequests).toBe(1);
    expect(dom.window.document.querySelector("#status")?.textContent).toBe("Added 2 files.");

    select.click();
    expect(select.textContent).toBe("Cancel");
    expect(add.hidden).toBe(true);
    expect(remove.hidden).toBe(false);
    expect(trash.hidden).toBe(false);
    expect(remove.disabled).toBe(true);
    const checkboxes = [...dom.window.document.querySelectorAll<HTMLInputElement>(".file-check")];
    expect(checkboxes).toHaveLength(2);
    checkboxes.forEach((checkbox) => checkbox.click());
    expect(remove.disabled).toBe(false);

    remove.click();
    const popover = dom.window.document.querySelector<HTMLElement>("#confirm-popover")!;
    expect(popover.classList.contains("open")).toBe(true);
    expect(dom.window.document.querySelector("#confirm-message")?.textContent).toBe("Remove 2 selected files from the queue?");
    expect(actionRequests).toHaveLength(0);
    dom.window.document.querySelector<HTMLButtonElement>("#confirm-action")!.click();
    await Bun.sleep(10);
    expect(actionRequests).toEqual(files.map((entry) => ({ path: entry.path, action: "remove" })));
    expect(select.textContent).toBe("Select");
    expect(add.hidden).toBe(false);
    expect(remove.hidden).toBe(true);

    select.click();
    [...dom.window.document.querySelectorAll<HTMLInputElement>(".file-check")].forEach((checkbox) => checkbox.click());
    trash.click();
    expect(dom.window.document.querySelector("#confirm-message")?.textContent).toBe("Move 2 selected files to the Trash?");
    dom.window.document.querySelector<HTMLButtonElement>("#confirm-action")!.click();
    await Bun.sleep(10);
    expect(actionRequests.slice(2)).toEqual(files.map((entry) => ({ path: entry.path, action: "trash" })));
    expect(select.textContent).toBe("Select");
    expect(add.hidden).toBe(false);

    select.click();
    dom.window.document.querySelector<HTMLInputElement>(".file-check")!.click();
    expect(remove.disabled).toBe(false);
    select.click();
    expect(select.textContent).toBe("Select");
    expect(dom.window.document.querySelectorAll(".file-check")).toHaveLength(0);
    expect(remove.hidden).toBe(true);
    expect(add.hidden).toBe(false);
    dom.window.document.querySelector<HTMLButtonElement>(".file")!.click();
    await Bun.sleep(0);
    expect(dom.window.document.querySelector("#status")?.textContent).toBe("Opened.");
    expect(timers.size).toBe(1);
    timers.values().next().value?.();
    expect(dom.window.document.querySelector("#status")?.textContent).toBe("");
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
    const registry = new (await import("../src/recents/registry")).RecentsRegistry(file.config.recentsPath);
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
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "launch_failed", message: "Wave update failed" } });
    expect(daemon.sessions.size).toBe(0);
  });

  test("scopes the Recents page and opens only registered files in a new view", async () => {
    const file = await fixture();
    const opened: string[] = [];
    const daemon = createDaemon({ config: file.config, startupGraceMs: 600_000, opener: async (url) => { opened.push(url); }, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    await new (await import("../src/recents/registry")).RecentsRegistry(file.config.recentsPath).add(file.other);
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
    const host = {
      id: "cmux" as const,
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: true }),
      openView: async (request: OpenViewRequest) => { requests.push(request); },
      openExternal: async () => {},
    };
    const daemon = createDaemon({ config: file.config, hostAdapter: host, startupGraceMs: 600_000, web: () => new Response("web") });
    daemons.push(daemon);
    await daemon.ready;
    await new (await import("../src/recents/registry")).RecentsRegistry(file.config.recentsPath).add(file.other);
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
