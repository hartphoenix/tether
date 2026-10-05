import { afterEach, expect, mock, test } from "bun:test";
import { acceptBatch, hasOpener, lendOpener, runOrHold, sourceKey, type Delivery } from "../integrations/paseo/client/state";
import type { PumpBatch } from "../integrations/paseo/shared/contracts";
// Reader panels open only on desktop; this test stands in for it.
mock.module("../integrations/paseo/client/web", () => ({ isDesktop: () => true }));
// Keep React Native globals out of the root DOM typecheck; the plugin has its own tsc check.
const readerModule = "../integrations/paseo/client/reader-panels";
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type ReaderPanels = {
  readerPanelId(path: string): string;
  fileName(path: string): string;
  readerDocument(panelId: string): { path: string; name: string } | undefined;
  openReaderPanels(storage: Storage): Set<string> | null;
  startReaderPanels(client: unknown, component: unknown, storage: Storage): () => void;
  takeLaunch(panelId: string, workspaceId: string): string | undefined;
  relaunch(panelId: string, workspaceId: string, request: () => Promise<unknown>): Promise<string>;
  mountReader(panelId: string, workspaceId: string, reopen: (url: string) => void): () => void;
  savedSession(cacheKey: string): string | undefined;
  saveSession(cacheKey: string, url: string | undefined): void;
};
const readers = await import(readerModule) as ReaderPanels;

type Registration = { id: string; title: string; icon: string; locations?: readonly string[]; removed: boolean };
const batch = (readerPanels: boolean, folio: PumpBatch["folio"] = []): PumpBatch => ({
  connection: { generation: "g1", tetherPath: "", profile: "preview" }, revision: 0, folio, notices: {}, intents: [], buttons: true, readerPanels,
  // Its own daemon identity, so opened-intent deduplication can't collide with other state tests.
  status: { connected: true, tether: "reader-panels-daemon", error: null },
});
const delivery = (id: string, path?: string, url = `http://127.0.0.1:1/launch?ticket=${id}`): Delivery => ({ generation: "g1", source: sourceKey(), id, url, workspaceId: "w1", ...(path ? { path } : {}) });

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, read: (key: string) => JSON.parse(values.get(key) ?? "null") };
}

function fakeClient() {
  const panels: Registration[] = [];
  const opened: Array<{ id: string; workspaceId: string; location?: string }> = [];
  const acked: string[][] = [];
  const client = {
    addWorkspacePanel: (contribution: any) => {
      const registration: Registration = { id: contribution.id, title: contribution.title, icon: contribution.icon, locations: contribution.locations, removed: false };
      panels.push(registration);
      return () => { registration.removed = true; };
    },
    openPanel: (id: string, options: { workspaceId: string; location?: string }) => { opened.push({ id, ...options }); },
    rpc: async (_contract: unknown, input: any) => { acked.push(input.ids); return { acknowledged: input.ids.length }; },
  };
  return { client, panels, opened, acked };
}

const component = () => () => null;
let stop = () => {};
afterEach(() => { stop(); acceptBatch(batch(false)); });

test("panel IDs are valid Paseo contribution IDs and stable per path", () => {
  const id = readers.readerPanelId("/Users/me/notes/Plan.md");
  expect(id).toMatch(/^reader-[0-9a-f]{16}$/);
  expect(readers.readerPanelId("/Users/me/notes/Plan.md")).toBe(id);
  expect(readers.readerPanelId("/Users/me/notes/plan.md")).not.toBe(id);
  expect(readers.fileName("/a/b/Weekly review.markdown")).toBe("Weekly review");
});

test("in panel mode, a document intent registers one titled panel and opens it", () => {
  const { client, panels, opened, acked } = fakeClient();
  const storage = memoryStorage();
  stop = readers.startReaderPanels(client, component, storage);
  expect(hasOpener()).toBe(false);
  acceptBatch(batch(true, [{ path: "/w/doc.md", name: "Doc title", directory: "/w", repository: null, pinned: false, missing: false, attentionCount: 0, openedAt: 1 }]));
  expect(hasOpener()).toBe(true);

  expect(runOrHold(delivery("a", "/w/doc.md"), () => {})).toBe(true);
  const id = readers.readerPanelId("/w/doc.md");
  expect(panels).toEqual([{ id, title: "Doc title", icon: "FileText", locations: ["workspace"], removed: false }]);
  expect(opened).toEqual([{ id, workspaceId: "w1", location: "workspace" }]);
  expect(readers.takeLaunch(id, "w1")).toBe("http://127.0.0.1:1/launch?ticket=a");
  expect(readers.takeLaunch(id, "w1")).toBeUndefined();
  expect(storage.read("tether.reader-panels.v1")).toEqual({ [id]: { path: "/w/doc.md", name: "Doc title" } });

  // A second open of the same document reuses its panel.
  runOrHold(delivery("b", "/w/doc.md"), () => {});
  expect(panels).toHaveLength(1);
  expect(opened).toHaveLength(2);
  expect(acked).toEqual([]);
});

test("intents without a path, or with the setting off, use the Folio's browser opener", () => {
  const { client, opened } = fakeClient();
  stop = readers.startReaderPanels(client, component, memoryStorage());
  const browser: string[] = [];
  const release = lendOpener(intent => { browser.push(intent.id); }, () => {});
  acceptBatch(batch(true));
  runOrHold(delivery("no-path"), () => {});
  acceptBatch(batch(false));
  runOrHold(delivery("off", "/w/doc.md"), () => {});
  expect(browser).toEqual(["no-path", "off"]);
  expect(opened).toEqual([]);
  release();
});

test("a requested relaunch reaches the mounted panel without moving focus", async () => {
  const { client, opened } = fakeClient();
  stop = readers.startReaderPanels(client, component, memoryStorage());
  acceptBatch(batch(true));
  const id = readers.readerPanelId("/w/doc.md");
  const release = readers.mountReader(id, "w1", () => { throw new Error("not a heading link"); });
  let requested = 0;
  const launch = readers.relaunch(id, "w1", async () => { requested++; });
  runOrHold(delivery("fresh", "/w/doc.md"), () => {});
  expect(await launch).toBe("http://127.0.0.1:1/launch?ticket=fresh");
  expect(requested).toBe(1);
  expect(opened).toEqual([]);

  // A user's open of a mounted reader focuses it and keeps its session.
  runOrHold(delivery("again", "/w/doc.md"), () => {});
  expect(opened).toEqual([{ id, workspaceId: "w1", location: "workspace" }]);
  expect(readers.takeLaunch(id, "w1")).toBeUndefined();

  // A link to a heading reopens it.
  const reopened: string[] = [];
  release();
  const releaseAgain = readers.mountReader(id, "w1", url => { reopened.push(url); });
  runOrHold(delivery("heading", "/w/doc.md", "http://127.0.0.1:1/launch?ticket=heading#plan"), () => {});
  expect(reopened).toEqual(["http://127.0.0.1:1/launch?ticket=heading#plan"]);
  releaseAgain();
});

test("a failed relaunch request rejects and leaves later opens focusing", async () => {
  const { client, opened } = fakeClient();
  stop = readers.startReaderPanels(client, component, memoryStorage());
  acceptBatch(batch(true));
  const id = readers.readerPanelId("/w/doc.md");
  await expect(readers.relaunch(id, "w1", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  runOrHold(delivery("user", "/w/doc.md"), () => {});
  expect(opened).toEqual([{ id, workspaceId: "w1", location: "workspace" }]);
});

test("startup restores saved panels that Paseo's layout still shows and forgets the rest", () => {
  const kept = readers.readerPanelId("/w/kept.md");
  const closed = readers.readerPanelId("/w/closed.md");
  const layout = { state: { layoutByWorkspace: { "s:w1": { root: { kind: "group", group: { children: [
    { kind: "pane", pane: { tabs: [{ target: { kind: "plugin", pluginId: "tether", panelId: kept, context: "workspace" } }, { target: { kind: "browser", browserId: "b" } }] } },
    { kind: "pane", pane: { tabs: [{ target: { kind: "plugin", pluginId: "other", panelId: closed } }] } },
  ] } } } } } };
  const storage = memoryStorage({
    "workspace-layout-state": layout,
    "tether.reader-panels.v1": { [kept]: { path: "/w/kept.md", name: "Kept" }, [closed]: { path: "/w/closed.md", name: "Closed" }, "reader-forged": { path: "/w/x.md", name: "X" } },
  });
  const { client, panels } = fakeClient();
  stop = readers.startReaderPanels(client, component, storage);
  expect(panels.map(panel => panel.id)).toEqual([kept]);
  expect(readers.readerDocument(kept)).toEqual({ path: "/w/kept.md", name: "Kept" });
  expect(storage.read("tether.reader-panels.v1")).toEqual({ [kept]: { path: "/w/kept.md", name: "Kept" } });
  stop();
  expect(panels[0]!.removed).toBe(true);
  stop = () => {};
});

test("an unreadable layout keeps every saved panel", () => {
  const id = readers.readerPanelId("/w/doc.md");
  const storage = memoryStorage({ "workspace-layout-state": { state: { layoutByWorkspace: { "s:w1": { root: { kind: "unknown" } } } } }, "tether.reader-panels.v1": { [id]: { path: "/w/doc.md", name: "Doc" } } });
  expect(readers.openReaderPanels(storage)).toBeNull();
  const { client, panels } = fakeClient();
  stop = readers.startReaderPanels(client, component, storage);
  expect(panels.map(panel => panel.id)).toEqual([id]);
});

test("reader sessions persist by key and are discarded on failure", () => {
  const storage = memoryStorage();
  const { client } = fakeClient();
  stop = readers.startReaderPanels(client, component, storage);
  readers.saveSession("k1", "http://127.0.0.1:1/s/view/");
  expect(readers.savedSession("k1")).toBe("http://127.0.0.1:1/s/view/");
  readers.saveSession("k1", undefined);
  expect(readers.savedSession("k1")).toBeUndefined();
});
