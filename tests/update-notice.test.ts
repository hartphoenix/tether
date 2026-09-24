import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountUpdateNotice } from "../src/web/update-notice";

function page(withPackageButton = false) {
  const dom = new JSDOM('<p id="notice" hidden></p><button id="menu-check" hidden>Check for updates</button><button id="package" hidden aria-expanded="false">Update Available</button>', { runScripts: "outside-only", url: "http://127.0.0.1/r/test/", pretendToBeVisual: true });
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
      if (endpoint.endsWith("/dismiss")) state = { ...(state as object), available: null };
      if (endpoint.endsWith("/check")) return Response.json(state);
      return Response.json({ ok: true });
    }
    return Response.json(state);
  } });
  dom.window.eval(`(${mountUpdateNotice.toString()})(document.querySelector('#notice'),'./api',undefined,undefined,true,document.querySelector('#menu-check'),${withPackageButton ? "document.querySelector('#package')" : "undefined"})`);
  return { dom, requests, notice: dom.window.document.querySelector<HTMLElement>("#notice")!, offline: () => { offline = true; }, state: (value: unknown) => { state = value; }, refresh: () => dom.window.dispatchEvent(new dom.window.Event("pageshow")) };
}

test("update notice offers notes, immediate install, and persistent dismissal action", async () => {
  const p = page(); await Bun.sleep(0);
  expect(p.notice.textContent).toBe("Tether update available: version 0.2.0. Release Notes | Install | Dismiss");
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
  p.state({ managed: true, available: null }); p.refresh(); await Bun.sleep(0);
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

test("reader update notices open release notes in a new tab without a check action", async () => {
  const f = await fixture();
  try {
    expect(f.dom.window.document.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(f.dom.window.document.querySelector("a")?.target).toBe("_blank");
    expect(f.button("Check for updates")).toBeUndefined();
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

test("customized skill review remains visible after an application update", async () => {
  const p = page(); await Bun.sleep(0);
  p.state({ managed: true, available: null, agentSkillReviewNeeded: true });
  p.refresh(); await Bun.sleep(0);
  expect(p.notice.hidden).toBe(false);
  expect(p.notice.textContent).toContain("Review agent instructions");
  p.dom.window.close();
});

async function reviewFixture() {
  const dom = new JSDOM('<p id="notice" hidden></p><button id="menu-check" hidden>Check for updates</button>', { runScripts: "outside-only", url: "http://127.0.0.1/r/test/", pretendToBeVisual: true });
  const calls: Array<{ path: string; body?: any }> = [], copied: string[] = [];
  let hasReview = true, reject = false;
  const review = { id: "registered-id", path: "/skills/tether-review/SKILL.md", current: "My <custom> instructions", proposed: "Updated instructions", candidate: null as string | null, revision: "snapshot-one", mergePrompt: "Prepare a candidate without changing the installed skill." };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.dispatchEvent(new dom.window.Event("close")); };
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  Object.assign(dom.window, { AbortSignal, setInterval: () => 0, fetch: async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
    if (path.endsWith("/skills")) return Response.json(hasReview ? [{ id: review.id, path: review.path }] : []);
    if (path.endsWith("/skills/read")) return Response.json(review);
    if (path.endsWith("/skills/decide")) {
      if (reject) return Response.json({ error: { message: "The skill changed. Refresh the comparison." } }, { status: 409 });
      hasReview = false; return Response.json({ ok: true });
    }
    return Response.json({ managed: true, available: null, agentSkillReviewNeeded: hasReview });
  } });
  dom.window.eval(`(${mountUpdateNotice.toString()})(document.querySelector('#notice'),'./api',undefined,undefined,true,document.querySelector('#menu-check'))`);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10)); await settle();
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find(node => (node.textContent === label || node.getAttribute("aria-label") === label))!;
  return { dom, calls, copied, review, settle, button, reject: () => { reject = true; } };
}

test("skill review compares text safely and copies a merge prompt without approving", async () => {
  const f = await reviewFixture();
  try {
    f.button("Review agent instructions").click(); await f.settle();
    const dialog = f.dom.window.document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("My <custom> instructions");
    expect(dialog.querySelector("custom")).toBeNull();
    f.button("Ask my agent to merge").click(); await f.settle();
    expect(f.copied).toEqual([f.review.mergePrompt]);
    expect(f.calls.some(call => call.path.endsWith("/decide"))).toBe(false);
    expect(f.button("Approve merged instructions")).toBeUndefined();
    const copiedButton = f.button("Prompt copied — paste in agent chat");
    expect(copiedButton.dataset.copied).toBe("true");
    copiedButton.click(); await f.settle();
    expect(f.copied).toEqual([f.review.mergePrompt, f.review.mergePrompt]);
    expect([...dialog.querySelectorAll(".review-actions button")].map(node => node.textContent)).toEqual(["Accept new version", "Keep old version", "Prompt copied — paste in agent chat"]);
    expect(f.calls.some(call => call.path.endsWith("/decide"))).toBe(false);
  } finally { f.dom.window.close(); }
});

test("skill approval reports a stale comparison and leaves review available", async () => {
  const f = await reviewFixture();
  try {
    f.button("Review agent instructions").click(); await f.settle(); f.reject();
    f.button("Accept new version").click(); await f.settle();
    expect(f.dom.window.document.querySelector("dialog")?.textContent).toContain("The skill changed.");
    expect(f.button("Accept new version").disabled).toBe(false);
    expect(f.button("Review agent instructions")).toBeDefined();
    f.button("Close").click();
    expect(f.dom.window.document.querySelector("dialog")).toBeNull();
  } finally { f.dom.window.close(); }
});

test("keeping a skill records a decision and clears its review notice", async () => {
  const f = await reviewFixture();
  try {
    f.button("Review agent instructions").click(); await f.settle();
    f.button("Keep old version").click(); await f.settle();
    expect(f.calls.find(call => call.path.endsWith("/decide"))?.body.action).toBe("keep");
    expect(f.dom.window.document.querySelector("#notice")?.textContent).not.toContain("Review agent instructions");
  } finally { f.dom.window.close(); }
});

test("dismissing an app update does not dismiss an outstanding skill review", async () => {
  const p = page(); await Bun.sleep(0);
  p.state({ managed: true, agentSkillReviewNeeded: true, available: { tag: "v0.2.0", version: "0.2.0", notes: "https://github.com/hartphoenix/tether/releases/tag/v0.2.0" } });
  p.refresh(); await Bun.sleep(0);
  [...p.notice.querySelectorAll("button")].find(button => button.textContent === "Dismiss")!.click(); await Bun.sleep(0);
  expect(p.notice.hidden).toBe(false);
  expect(p.notice.textContent).toContain("Review agent instructions");
  expect(p.notice.textContent).not.toContain("Install |");
  p.dom.window.close();
});


test("Folio menu checks package updates while the idle notification stays hidden", async () => {
  const p = page(); await Bun.sleep(0);
  try {
    const menu = p.dom.window.document.querySelector<HTMLButtonElement>("#menu-check")!;
    p.state({ managed: true, available: null }); p.refresh(); await Bun.sleep(0);
    expect(p.notice.hidden).toBe(true);
    expect(menu.hidden).toBe(false);
    menu.click(); await Bun.sleep(0);
    expect(p.requests).toContainEqual({ endpoint: "./api/updates/check", body: {} });
    p.state({ managed: false, available: null }); p.refresh(); await Bun.sleep(0);
    expect(menu.hidden).toBe(true);
    expect(p.notice.hidden).toBe(true);
  } finally { p.dom.window.close(); }
});


test("package trigger opens update controls and hides when the update is dismissed", async () => {
  const p = page(true); await Bun.sleep(0);
  try {
    const trigger = p.dom.window.document.querySelector<HTMLButtonElement>("#package")!;
    expect(trigger.hidden).toBe(false);
    expect(p.notice.hidden).toBe(true);
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(p.notice.hidden).toBe(false);
    p.dom.window.document.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(p.notice.hidden).toBe(true);
    expect(p.dom.window.document.activeElement === trigger).toBe(true);
    trigger.click();
    p.dom.window.document.body.dispatchEvent(new p.dom.window.Event("pointerdown", { bubbles: true }));
    expect(p.notice.hidden).toBe(true);
    trigger.click();
    [...p.notice.querySelectorAll("button")].find(button => button.textContent === "Dismiss")!.click();
    await Bun.sleep(0);
    expect(trigger.hidden).toBe(true);
    expect(p.notice.hidden).toBe(true);
  } finally { p.dom.window.close(); }
});

test("a manual check always reports progress and its result", async () => {
  const p = page(); await Bun.sleep(0);
  try {
    const menu = p.dom.window.document.querySelector<HTMLButtonElement>("#menu-check")!;
    p.state({ managed: true, available: null, version: "0.1.1" }); p.refresh(); await Bun.sleep(0);
    menu.click();
    expect(p.notice.textContent).toBe("Checking for updates…");
    await Bun.sleep(0);
    expect(p.notice.textContent).toBe("Tether 0.1.1 is up to date. OK");
    p.state({ managed: true, available: null, unavailableReason: "This installation has no update trust root." });
    menu.click(); await Bun.sleep(0);
    expect(p.notice.textContent).toStartWith("Tether can't check for updates on this installation. This installation has no update trust root.");
    p.offline(); menu.click(); await Bun.sleep(0);
    expect(p.notice.textContent).toBe("Couldn't reach Tether to check for updates. Run tether to reconnect. Try again | Dismiss");
  } finally { p.dom.window.close(); }
});

test("an unavailable update channel stays quiet until the user checks", async () => {
  const p = page(); await Bun.sleep(0);
  p.state({ managed: true, available: null, unavailableReason: "This installation has no update trust root." }); p.refresh(); await Bun.sleep(0);
  expect(p.notice.hidden).toBe(true);
  p.dom.window.close();
});

test("prolonged failure offers a check that replaces the notice with its result", async () => {
  const p = page(); await Bun.sleep(0);
  try {
    p.state({ managed: true, available: null, checkFailed: true, prolongedFailure: true, checkError: "Tether couldn't reach the update server." });
    p.refresh(); await Bun.sleep(0);
    expect(p.notice.textContent).toBe("Tether hasn't been able to check for updates for two days. Tether couldn't reach the update server. Check now | Dismiss");
    p.state({ managed: true, available: null, version: "0.1.1" });
    [...p.notice.querySelectorAll("button")].find(button => button.textContent === "Check now")!.click();
    expect(p.notice.textContent).toBe("Checking for updates…");
    await Bun.sleep(0);
    expect(p.requests).toContainEqual({ endpoint: "./api/updates/check", body: {} });
    expect(p.notice.textContent).toBe("Tether 0.1.1 is up to date. OK");
    p.state({ managed: true, available: null, checkFailed: true, prolongedFailure: true, checkError: "Offline." }); p.refresh(); await Bun.sleep(0);
    [...p.notice.querySelectorAll("button")].find(button => button.textContent === "Dismiss")!.click();
    expect(p.notice.hidden).toBe(true);
    p.refresh(); await Bun.sleep(0);
    expect(p.notice.hidden).toBe(true);
  } finally { p.dom.window.close(); }
});

test("a manual check during a background check is queued, not dropped", async () => {
  const p = page(); await Bun.sleep(0);
  try {
    p.state({ managed: true, available: null, version: "0.1.1" });
    p.refresh(); p.dom.window.document.querySelector<HTMLButtonElement>("#menu-check")!.click();
    expect(p.notice.textContent).toBe("Checking for updates…");
    await Bun.sleep(10);
    expect(p.requests).toContainEqual({ endpoint: "./api/updates/check", body: {} });
    expect(p.notice.textContent).toBe("Tether 0.1.1 is up to date. OK");
  } finally { p.dom.window.close(); }
});
