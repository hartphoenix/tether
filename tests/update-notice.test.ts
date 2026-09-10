import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountUpdateNotice } from "../src/web/update-notice";

function page() {
  const dom = new JSDOM('<p id="notice" hidden></p>', { runScripts: "outside-only", url: "http://127.0.0.1/r/test/", pretendToBeVisual: true });
  const requests: { endpoint: string; body: unknown }[] = [];
  let state: unknown = { available: { tag: "v0.2.0", version: "0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" } };
  let offline = false;
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
  expect(p.notice.textContent).toBe("Tether update available: version 0.2.0. Install | Release Notes | Dismiss");
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
