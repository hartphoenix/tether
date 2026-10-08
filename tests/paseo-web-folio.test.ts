import { afterEach, beforeEach, expect, test } from "bun:test";
import { disposeFolioViews, folioViewKey, mountFolioWebview, type FolioViewState } from "../integrations/paseo/client/web-folio";
import { themedLaunch } from "../integrations/paseo/client/theme-sync";

class Guest {
  style = { width: "", height: "", display: "", flex: "" };
  attributes: Array<[string, string]> = [];
  listeners = new Map<string, (event: any) => void>();
  removed = false;
  setAttribute(name: string, value: string) { this.attributes.push([name, value]); }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  remove() { this.removed = true; }
  emit(name: string, event: object = {}) { this.listeners.get(name)?.(event); }
  navigate(url = session, status = 200) { this.emit("did-frame-navigate", { isMainFrame: true, url, httpResponseCode: status }); }
  ready(url = session) { this.navigate(url); this.emit("dom-ready"); }
  get src() { return this.attributes.find(([name]) => name === "src")?.[1]; }
}
const origin = "http://127.0.0.1:3456";
const session = `${origin}/r/view-a/?instance=daemon-a`;
const ticket = () => ({ url: `${origin}/recents/launch?ticket=one-use`, expiresAt: Date.now() + 30_000 });
let guests: Guest[];
let documentDescriptor: PropertyDescriptor | undefined;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  guests = [];
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Guest() } });
});
afterEach(() => {
  disposeFolioViews();
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else Reflect.deleteProperty(globalThis, "document");
});

function mount(options: Partial<Parameters<typeof mountFolioWebview>[1]> = {}) {
  const states: FolioViewState[] = [];
  let launches = 0;
  const dispose = mountFolioWebview({ appendChild: (guest: Guest) => guests.push(guest) }, {
    cacheKey: "workspace-a", launch: async () => { launches++; return ticket(); },
    onState: state => states.push(state), ...options,
  });
  return { states, dispose, get launches() { return launches; } };
}

test("guest receives partition before source; only a successful session and DOM readiness are cached", async () => {
  const first = mount();
  await tick();
  const guest = guests[0]!;
  expect(guest.attributes.map(([name]) => name)).toEqual(["partition", "src"]);
  expect(guest.attributes[0]![1]).toBe("persist:paseo-browser");
  guest.emit("dom-ready");
  expect(first.states).toEqual(["loading"]);
  guest.navigate();
  expect(first.states).toEqual(["loading", "ready"]);
  first.dispose();
  expect(guest.removed).toBe(true);
  expect(guest.listeners.size).toBe(0);
  const second = mount();
  expect(second.launches).toBe(0);
  expect(guests[1]!.src).toBe(session);
  guests[1]!.ready();
  expect(second.states.at(-1)).toBe("ready");
});

test("theme-aware launches attach and cache only the final authenticated session", async () => {
  const launch = { ...ticket(), url: themedLaunch(ticket().url) };
  const first = mount({ launch: async () => launch });
  await tick();
  expect(guests).toHaveLength(1);
  expect(guests[0]!.src).toBe(launch.url);
  guests[0]!.ready();
  expect(first.states.at(-1)).toBe("ready");
  first.dispose();
  const next = mount();
  expect(next.launches).toBe(0);
  expect(guests[1]!.src).toBe(session);
});

test("connection and workspace identities do not reuse each other's sessions", async () => {
  const keys = [
    folioViewKey("host", "", "preview", "a"), folioViewKey("host", "", "preview", "b"),
    folioViewKey("host", "", "dev", "a"), folioViewKey("other", "", "preview", "a"),
    folioViewKey("host", "/new/tether", "preview", "a"),
  ];
  expect(new Set(keys).size).toBe(5);
  for (const cacheKey of keys) {
    const current = mount({ cacheKey });
    await tick();
    expect(current.launches).toBe(1);
    guests.at(-1)!.ready();
    current.dispose();
  }
});

test("cold concurrent mounts use distinct tickets; a failed older view cannot evict a newer session", async () => {
  let count = 0;
  const launch = async () => ({ ...ticket(), url: `${origin}/recents/launch?ticket=${++count}` });
  mount({ launch });
  mount({ launch });
  await tick();
  expect(count).toBe(2);
  expect(guests[0]!.src).not.toBe(guests[1]!.src);
  guests[0]!.ready();
  const newer = `${origin}/r/view-b/`;
  guests[1]!.ready(newer);
  guests[0]!.emit("render-process-gone");
  const next = mount();
  expect(next.launches).toBe(0);
  expect(guests[2]!.src).toBe(newer);
});

test("an HTTP 401 on a cached URL gets one fresh launch, then falls back on failure", async () => {
  const first = mount();
  await tick();
  guests[0]!.ready();
  first.dispose();
  const retry = mount();
  guests[1]!.navigate(session, 401);
  guests[1]!.emit("dom-ready");
  await tick();
  expect(retry.launches).toBe(1);
  expect(guests[1]!.removed).toBe(true);
  guests[2]!.navigate(ticket().url, 401);
  expect(retry.states.at(-1)).toBe("failed");
  expect(guests[2]!.listeners.size).toBe(0);
  await tick();
  expect(retry.launches).toBe(1);
});

test("subframes and aborted loads do not fail Folio; renderer loss after ready does", async () => {
  const current = mount();
  await tick();
  const guest = guests[0]!;
  guest.emit("did-fail-load", { isMainFrame: false, errorCode: -2 });
  guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
  guest.emit("did-frame-navigate", { isMainFrame: false, httpResponseCode: 401 });
  guest.ready();
  expect(current.states).toEqual(["loading", "ready"]);
  guest.emit("render-process-gone");
  expect(current.states.at(-1)).toBe("failed");
  const next = mount();
  await tick();
  expect(next.launches).toBe(1);
});

test("a later failed reload invalidates the ready session and does not loop", async () => {
  const current = mount();
  await tick();
  const guest = guests[0]!;
  guest.ready();
  guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  guest.navigate(session, 401);
  expect(current.states.at(-1)).toBe("failed");
  const next = mount();
  await tick();
  expect(next.launches).toBe(1);
});

test("cancelled navigation preserves a ready guest but does not bypass initial-load timeout", async () => {
  const current = mount({ loadTimeoutMs: 10 });
  await tick();
  const guest = guests[0]!;
  guest.ready();
  guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(current.states).toEqual(["loading", "ready"]);
  expect(guest.removed).toBe(false);
  guest.emit("render-process-gone");
  expect(current.states.at(-1)).toBe("failed");

  const initial = mount({ loadTimeoutMs: 10 });
  await tick();
  guests[1]!.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  guests[1]!.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(initial.states.at(-1)).toBe("failed");
});

test("attachment and RPC deadlines fall back and ignore late completion", async () => {
  const attached = mount({ loadTimeoutMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(attached.states.at(-1)).toBe("failed");
  expect(guests[0]!.removed).toBe(true);
  let resolve!: (value: ReturnType<typeof ticket>) => void;
  const pending = mount({ cacheKey: "pending", launchTimeoutMs: 10, launch: () => new Promise(done => { resolve = done; }) });
  await new Promise(done => setTimeout(done, 25));
  expect(pending.states.at(-1)).toBe("failed");
  resolve(ticket());
  await tick();
  expect(guests).toHaveLength(1);
});

test("unmount during launch and plugin teardown make late results inert", async () => {
  let resolve!: (value: ReturnType<typeof ticket>) => void;
  const old = mount({ launch: () => new Promise(done => { resolve = done; }) });
  await tick();
  old.dispose();
  const next = mount({ cacheKey: "new-profile" });
  await tick();
  guests[0]!.ready();
  resolve(ticket());
  await tick();
  expect(guests).toHaveLength(1);
  expect(old.states).toEqual(["loading"]);
  disposeFolioViews();
  expect(guests[0]!.removed).toBe(true);
  const restarted = mount({ cacheKey: "new-profile" });
  await tick();
  expect(restarted.launches).toBe(1);
  next.dispose();
});

test("load failure, missing DOM, mount exceptions, expired launch, and rejected RPC fall back", async () => {
  const load = mount();
  await tick();
  guests[0]!.emit("did-fail-load", { isMainFrame: true, errorCode: -102 });
  expect(load.states.at(-1)).toBe("failed");
  const expired = mount({ launch: async () => ({ ...ticket(), expiresAt: 0 }) });
  const rejected = mount({ launch: async () => { throw new Error("unavailable"); } });
  await tick();
  expect(expired.states.at(-1)).toBe("failed");
  expect(rejected.states.at(-1)).toBe("failed");
  Reflect.deleteProperty(globalThis, "document");
  const missing = mount();
  await tick();
  expect(missing.states.at(-1)).toBe("failed");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => { throw new Error("blocked"); } } });
  const blocked = mount();
  await tick();
  expect(blocked.states.at(-1)).toBe("failed");
});

test("only local launch URLs and same-origin session navigations are accepted", async () => {
  for (const url of ["https://example.com/recents/launch?ticket=x", `${origin}/wrong?ticket=x`, `${origin}/recents/launch`, `${origin}/recents/launch?ticket=x&extra=y`,
    `${origin}/recents/launch?ticket=x&themeClient=invalid`, `${origin}/recents/launch?ticket=x&themeClient=`,
    `${origin}/recents/launch?ticket=x&themeClient=${crypto.randomUUID()}&themeClient=${crypto.randomUUID()}`,
    `${origin}/recents/launch?ticket=x&ticket=y`]) {
    const invalid = mount({ launch: async () => ({ ...ticket(), url }) });
    await tick();
    expect(invalid.states.at(-1)).toBe("failed");
  }
  expect(guests).toHaveLength(0);
  for (const url of ["http://127.0.0.1:9999/r/other/", `${origin}/recents/launch?ticket=x`, `${origin}/r/view/?ticket=x`]) {
    const invalid = mount();
    await tick();
    guests.at(-1)!.ready(url);
    expect(invalid.states.at(-1)).toBe("failed");
  }
});

test("Settings requests open a browser pane without navigating or replacing the Folio guest", async () => {
  const { JSDOM } = await import("jsdom");
  const { folioHtml, folioTheme } = await import("../src/web/folio-page");
  for (const shared of [false, true]) {
    const root = shared ? "https://hub.example/folio/?embedded=1" : session + "&embedded=1";
    const opened: string[] = [];
    const current = mount({ cacheKey: root, onOpenBrowser: url => opened.push(url), ...(shared ? {
      launch: async () => ({ url: root, sharedOrigin: "https://hub.example", expiresAt: Date.now() + 30_000 }),
    } : {}) });
    await tick();
    const guest = guests.at(-1)!; guest.ready(root);
    const dom = new JSDOM(folioHtml({ embedded: true, shared }), { url: root, runScripts: "outside-only", pretendToBeVisual: true });
    Object.assign(dom.window, {
      fetch: async () => Response.json({ sequence: 1, files: [], preferences: folioTheme(), retention: { mode: "forever" } }),
      setInterval: () => 0,
    });
    dom.window.console.info = (message: string) => guest.emit("console-message", { message, sourceId: dom.window.location.href });
    try {
      dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
      await tick();
      const settings = dom.window.document.querySelector<HTMLButtonElement>('[data-app-action="settings"]')!;
      settings.click(); settings.click();
      const expected = shared ? "https://hub.example/settings/" : `${origin}/r/view-a/settings`;
      expect(opened).toEqual([expected, expected]);
      expect(dom.window.location.href).toBe(root);
      expect(current.states).toEqual(["loading", "ready"]);
      expect(guest.removed).toBe(false);
      if (shared) {
        const reader = `https://hub.example/reader/d/${crypto.randomUUID()}/`;
        let archived = false;
        dom.window.fetch = async (input, init) => {
          const endpoint = String(input).split("/").at(-1);
          if (endpoint === "machines") return Response.json([{ id: "machine", name: "Files" }]);
          if (endpoint === "pick") {
            if (archived && !JSON.parse(String(init?.body)).restoreArchived) return Response.json({ error: { code: "restore_required", message: "Archived" } }, { status: 409 });
            return Response.json({ url: reader });
          }
          return Response.json({ sequence: 1, files: [], retention: { mode: "forever" } });
        };
        for (const restore of [false, true]) {
          archived = restore;
          dom.window.document.querySelector<HTMLButtonElement>('#add')!.click(); await tick();
          expect(dom.window.document.querySelector('#path-dialog')!.classList.contains('open')).toBe(true);
          dom.window.document.querySelector<HTMLInputElement>('#path-value')!.value = '/notes.md';
          dom.window.document.querySelector<HTMLFormElement>('#path-form')!.requestSubmit(); await tick();
          if (restore) {
            expect(dom.window.document.querySelector('#confirm-dialog')!.classList.contains('open')).toBe(true);
            dom.window.document.querySelector<HTMLButtonElement>('#confirm-action')!.click(); await tick();
          }
          expect(opened.at(-1)).toBe(reader);
          expect(dom.window.location.href).toBe(root);
          expect(guest.removed).toBe(false);
        }
        expect(opened).toEqual([expected, expected, reader, reader]);
      }
    } finally { dom.window.close(); current.dispose(); }
  }
});

test("browser requests are restricted to the loaded Folio and approved destinations", async () => {
  const opened: string[] = [];
  const current = mount({ onOpenBrowser: url => opened.push(url) });
  await tick(); const guest = guests[0]!;
  const message = (url: string, sourceId = session) => guest.emit("console-message", { message: "tether:open-browser:" + url, sourceId });
  message(`${origin}/r/view-a/settings`); // Not ready yet.
  guest.ready();
  message(`${origin}/r/view-a/settings`, "https://elsewhere.example/");
  for (const target of ["https://elsewhere.example/settings", `${origin}/r/other/settings`, `${origin}/control/stop`, `${origin}/r/view-a/settings?extra=1`]) message(target);
  expect(opened).toEqual([]);
  message(`${origin}/r/view-a/settings`);
  expect(opened).toEqual([`${origin}/r/view-a/settings`]);
  expect(current.states.at(-1)).toBe("ready");
  current.dispose(); message(`${origin}/r/view-a/settings`);
  expect(opened).toHaveLength(1);
});

test("shared document requests use the same pane opener and leave Folio ready", async () => {
  const opened: string[] = [];
  const root = "https://hub.example/folio/?embedded=1";
  const current = mount({ launch: async () => ({ url: root, sharedOrigin: "https://hub.example", expiresAt: Date.now() + 30_000 }), onOpenBrowser: url => opened.push(url) });
  await tick(); const guest = guests[0]!; guest.ready(root);
  const reader = `https://hub.example/reader/d/${crypto.randomUUID()}/`;
  for (const target of ["https://elsewhere.example/settings/", "https://hub.example/auth/login", "https://hub.example/settings/?next=/folio/", "https://hub.example/folio/"]) {
    guest.emit("console-message", { message: "tether:open-browser:" + target, sourceId: root });
  }
  expect(opened).toEqual([]);
  guest.emit("console-message", { message: "tether:open-browser:" + reader, sourceId: root });
  expect(opened).toEqual([reader]); expect(current.states.at(-1)).toBe("ready"); expect(guest.removed).toBe(false);
});
