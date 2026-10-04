import { expect, test } from "bun:test";
import { getState, setState } from "../integrations/paseo/client/state";
import { findRestores, lendUrlOpener, MOVED_FROM_LABEL, readWorkspaceTabs, restoreTabs } from "../integrations/paseo/client/tab-restore";

// Shapes as Paseo 0.9 persists them in the app's localStorage.
const pane = (id: string, browsers: string[]) => ({
  kind: "pane",
  pane: { id, tabs: [{ tabId: "a", target: { kind: "agent", agentId: "x" } }, ...browsers.map(browserId => ({ tabId: `browser_${browserId}`, target: { kind: "browser", browserId } }))] },
});
const memory = (): Storage => {
  const items = new Map<string, string>();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } } as Storage;
};
const seeded = () => {
  const storage = memory();
  storage.setItem("workspace-layout-state", JSON.stringify({ state: { layoutByWorkspace: {
    "srv_1:wks_old": { root: { kind: "group", group: { children: [pane("main", ["b1"]), pane("side", ["b2", "b3", "b1"])] } } },
  } } }));
  storage.setItem("workspace-browser-store", JSON.stringify({ state: { browsersById: {
    b1: { url: "http://127.0.0.1:4000/r/doc" }, b2: { url: "https://example.com/" }, b3: { url: "about:blank" },
  } } }));
  return storage;
};

test("reads a workspace's browser tab URLs in pane order, http(s) only, without duplicates", () => {
  expect(readWorkspaceTabs(seeded(), "wks_old")).toEqual(["http://127.0.0.1:4000/r/doc", "https://example.com/"]);
  expect(readWorkspaceTabs(seeded(), "wks_other")).toEqual([]);
  expect(readWorkspaceTabs(memory(), "wks_old")).toEqual([]);
});

test("moved agents queue their old workspace's tabs for the new workspace", () => {
  const agents: { workspaceId: string; labels: Record<string, string> }[] = [
    { workspaceId: "wks_new", labels: { [MOVED_FROM_LABEL]: "wks_old" } },
    { workspaceId: "wks_plain", labels: {} },
    { workspaceId: "wks_empty", labels: { [MOVED_FROM_LABEL]: "wks_other" } },
  ];
  expect(findRestores(seeded(), agents)).toEqual({ wks_new: { from: "wks_old", urls: ["http://127.0.0.1:4000/r/doc", "https://example.com/"] } });
});

test("restores wait for a Folio panel, open once in the target workspace, then stay done", () => {
  const storage = seeded();
  (globalThis as any).localStorage = storage;
  setState({ restores: findRestores(storage, [{ workspaceId: "wks_new", labels: { [MOVED_FROM_LABEL]: "wks_old" } }]) });
  expect(restoreTabs("wks_new")).toBe(false);

  const opened: [string, string][] = [];
  const release = lendUrlOpener((url, workspaceId) => { opened.push([url, workspaceId]); });
  expect(opened).toEqual([["http://127.0.0.1:4000/r/doc", "wks_new"], ["https://example.com/", "wks_new"]]);
  expect(getState().restores).toEqual({});
  expect(restoreTabs("wks_new")).toBe(true);
  expect(opened.length).toBe(2);
  expect(findRestores(storage, [{ workspaceId: "wks_new", labels: { [MOVED_FROM_LABEL]: "wks_old" } }])).toEqual({});
  release();
  delete (globalThis as any).localStorage;
});
