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

test("reader views accept panel launches with a heading and cache the session without it", async () => {
  const sessions: Array<string | undefined> = [];
  const launch = `${origin}/launch?ticket=one-use&themeClient=00000000-0000-4000-8000-000000000000&surface=panel#plan`;
  const first = mount({ kind: "reader", cacheKey: "reader-a", launch: async () => ({ url: launch, expiresAt: Date.now() + 30_000 }), onSession: url => sessions.push(url) });
  await tick();
  expect(guests[0]!.src).toBe(launch);
  guests[0]!.ready(`${origin}/s/view-r/#plan`);
  expect(first.states.at(-1)).toBe("ready");
  expect(sessions).toEqual([`${origin}/s/view-r/`]);
  first.dispose();

  // A remount reuses the session; a fresh mount skips it.
  const again = mount({ kind: "reader", cacheKey: "reader-a" });
  expect(again.launches).toBe(0);
  expect(guests[1]!.src).toBe(`${origin}/s/view-r/`);
  again.dispose();
  const fresh = mount({ kind: "reader", cacheKey: "reader-a", fresh: true, launch: async () => ({ url: `${origin}/launch?ticket=two`, expiresAt: Date.now() + 30_000 }) });
  await tick();
  expect(guests[2]!.src).toBe(`${origin}/launch?ticket=two`);
  fresh.dispose();
});

test("a saved reader session is tried first and discarded when it fails", async () => {
  const sessions: Array<string | undefined> = [];
  const view = mount({ kind: "reader", cacheKey: "reader-b", saved: `${origin}/s/old/`, launch: async () => ({ url: `${origin}/launch?ticket=new`, expiresAt: Date.now() + 30_000 }), onSession: url => sessions.push(url) });
  expect(guests[0]!.src).toBe(`${origin}/s/old/`);
  guests[0]!.navigate(`${origin}/s/old/`, 401);
  expect(sessions).toEqual([undefined]);
  await tick();
  expect(guests[1]!.src).toBe(`${origin}/launch?ticket=new`);
  guests[1]!.ready(`${origin}/s/new/`);
  expect(sessions).toEqual([undefined, `${origin}/s/new/`]);
  view.dispose();
});

test("reader and Folio launches are not interchangeable", async () => {
  for (const [kind, url] of [
    ["reader", `${origin}/recents/launch?ticket=x`],
    ["reader", `${origin}/launch?ticket=x&surface=tab`],
    ["reader", `${origin}/launch?ticket=x&other=1`],
    ["folio", `${origin}/launch?ticket=x`],
    ["folio", `${origin}/recents/launch?ticket=x&surface=panel`],
    ["folio", `${origin}/recents/launch?ticket=x#plan`],
  ] as const) {
    const view = mount({ kind, cacheKey: `${kind}:${url}`, launch: async () => ({ url, expiresAt: Date.now() + 30_000 }) });
    await tick();
    expect(view.states.at(-1)).toBe("failed");
    view.dispose();
  }
  const reader = mount({ kind: "reader", cacheKey: "reader-c", launch: async () => ({ url: `${origin}/launch?ticket=x`, expiresAt: Date.now() + 30_000 }) });
  await tick();
  guests.at(-1)!.ready(`${origin}/r/folio-view/`);
  expect(reader.states.at(-1)).toBe("failed");
});
