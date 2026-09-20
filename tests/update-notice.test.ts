import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountUpdateNotice } from "../src/web/update-notice";

function page() {
  const dom = new JSDOM('<p id="notice" hidden></p>', { runScripts: "outside-only", url: "http://127.0.0.1/r/test/", pretendToBeVisual: true });
  const requests: { endpoint: string; body: unknown }[] = [];
  let state: unknown = { available: { tag: "v0.2.0", version: "0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" } };
  let offline = false;
  Object.assign(dom.window, { AbortSignal });
  Object.defineProperty(dom.window, "setInterval", { value: () => 0 });
  Object.defineProperty(dom.window, "fetch", { value: async (endpoint: string, init?: RequestInit) => {
    if (offline) throw new Error("Offline");
    if (init?.body) {
      requests.push({ endpoint, body: JSON.parse(String(init.body)) });
      if (endpoint.endsWith("/install")) state = { installing: true };
      if (endpoint.endsWith("/dismiss")) state = { available: null };
      return Response.json({ ok: true });
    }
    return Response.json(state);
  } });
  dom.window.eval(`(${mountUpdateNotice.toString()})(document.querySelector('#notice'),'./api')`);
  return { dom, requests, notice: dom.window.document.querySelector<HTMLElement>("#notice")!, offline: () => { offline = true; }, state: (value: unknown) => { state = value; }, refresh: () => dom.window.dispatchEvent(new dom.window.Event("pageshow")) };
}

test("brief bottom notice offers notes, immediate install, and persistent dismissal action", async () => {
  const p = page(); await Bun.sleep(0);
  expect(p.notice.textContent).toBe("Tether update available: version 0.2.0. Install | Release Notes | Dismiss | Check for updates");
  expect(p.notice.hidden).toBe(false);
  expect(p.notice.querySelector("a")!.href).toBe("https://github.com/hartphoenix/tether/releases/tag/v0.2.0");
  expect(p.notice.querySelector("a")!.rel).toContain("noreferrer");
  p.notice.querySelectorAll("button")[1]!.click(); await Bun.sleep(0);
  expect(p.requests).toEqual([{ endpoint: "./api/updates/dismiss", body: { tag: "v0.2.0" } }]);
  expect(p.notice.hidden).toBe(true);
  p.dom.window.close();
  const q = page(); await Bun.sleep(0);
  q.notice.querySelector("button")!.click(); await Bun.sleep(0);
  expect(q.requests).toEqual([{ endpoint: "./api/updates/install", body: { tag: "v0.2.0" } }]);
  expect(q.notice.textContent).toBe("Installing Tether update…");
  expect(q.notice.querySelector("button")).toBeNull();
  q.dom.window.close();
});

test("offline checks are passive, no update stays hidden, failed install remains retryable", async () => {
  const p = page(); await Bun.sleep(0);
  p.state({ available: null }); p.refresh(); await Bun.sleep(0);
  expect(p.notice.hidden).toBe(true);
  p.offline(); p.refresh(); await Bun.sleep(0);
  expect(p.notice.hidden).toBe(true);
  p.dom.window.close();
  const q = page(); await Bun.sleep(0);
  q.state({ available: { tag: "v0.2.0", version: "0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" }, failed: true });
  q.refresh(); await Bun.sleep(0);
  expect(q.notice.textContent).toStartWith("Update failed. Tether update available:");
  expect(q.notice.querySelector("button")!.disabled).toBe(false);
  q.dom.window.close();
});

async function fixture(beforeInstall?: () => Promise<void>) {
  const dom = new JSDOM('<aside id="notice"></aside>', { url: "http://127.0.0.1:8420/s/view/", pretendToBeVisual: true, runScripts: "outside-only" });
  const calls: string[] = [], errors: string[] = [];
  const state = { managed: true, available: { version: "0.2.0", tag: "v0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" }, installing: false, failed: false };
  Object.assign(dom.window, { AbortSignal, beforeInstall, report: (message: string) => errors.push(message), setInterval: () => 0,
    fetch: async (path: string) => { calls.push(path); return Response.json(state); } });
  dom.window.eval(`(${mountUpdateNotice.toString()})(document.querySelector('#notice'), '/s/view/api', report, beforeInstall, false)`);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10)); await settle();
  return { dom, calls, errors, settle, button: (label: string) => [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === label)! };
}

test("reader update notices check explicitly and link only verified release notes", async () => {
  const f = await fixture();
  try {
    expect(f.dom.window.document.querySelector("a")?.rel).toBe("noopener noreferrer");
    f.button("Check for updates").click(); await f.settle();
    expect(f.calls).toContain("/s/view/api/updates/check");
  } finally { f.dom.window.close(); }
});

test("reader update does not start when its draft cannot be persisted", async () => {
  const f = await fixture(async () => { throw new Error("offline"); });
  try {
    f.button("Install").click(); await f.settle();
    expect(f.calls).not.toContain("/s/view/api/updates/install");
    expect(f.errors).toHaveLength(1);
  } finally { f.dom.window.close(); }
});

test("reader update waits for draft persistence before asking the daemon to install", async () => {
  let ready!: () => void;
  const pending = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(() => pending);
  try {
    f.button("Install").click(); await f.settle();
    expect(f.calls).not.toContain("/s/view/api/updates/install");
    ready(); await f.settle();
    expect(f.calls).toContain("/s/view/api/updates/install");
  } finally { f.dom.window.close(); }
});
