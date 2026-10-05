/** Disposable integration check for the browser-hosted staging surface. */
import { builtInThemes, builtInDesign, contrastRatio } from "../src/shared/themes";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { startPhoneStage } from "./phone-reader-stage";
const external = process.env.PHONE_STAGE_URL;
if (external && (new URL(external).protocol !== "http:" || !new URL(external).hostname.endsWith(".localhost"))) throw new Error("Use a local Paseo staging service URL.");
const fixtureDir = external ? undefined : await mkdtemp(join(tmpdir(), "tether-stage-check-"));
const fixture = fixtureDir && join(fixtureDir, "diagrams.md");
if (fixture) await writeFile(fixture, "# Phone staging\n\nSelect this passage to add a comment.\n\n```mermaid\nflowchart LR\nPhone --> Reader --> Tether\n```\n\n```mermaid\nsequenceDiagram\nPhone->>Mac: Render with theme\nMac-->>Phone: SVG\n```\n");
const stage = external ? { url: external, close: async () => {} } : await startPhoneStage({ port: 0, document: fixture || undefined });
const stageFetch = (path: string, init: RequestInit = {}) => {
  const target = new URL(path, stage.url);
  const host = target.host;
  if (external) target.hostname = "127.0.0.1";
  return fetch(target, { ...init, headers: { ...init.headers, host } });
};
assert.equal((await (await stageFetch("/health")).json()).service, "tether-phone-stage");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  const errors: string[] = [];
  const diagramRequests: string[] = [], diagramLibraries: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/diagrams")) diagramRequests.push(request.url());
    if (/(?:mermaid|flowDiagram|dagre|elk)[^/]*\.js$/i.test(new URL(request.url()).pathname)) diagramLibraries.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(stage.url);
  const phone = page.frameLocator("#phone");
  assert.equal(await page.locator("#reader-theme").count(), 0);
  const chooseTheme = async (theme: string) => {
    await phone.locator("#theme").click();
    await phone.locator(`#theme-menu [data-theme="${theme}"]`).click();
    await phone.locator("#theme:not([disabled])").waitFor();
  };
  assert.equal(await phone.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content"), "yes");
  await phone.getByRole("button", { name: "Simulate passkey verification" }).click();
  await phone.locator(".ProseMirror h1").waitFor();
  await phone.locator(".wm-mermaid svg").first().waitFor();
  if (!external) await page.waitForFunction(() => (document.querySelector("#phone") as HTMLIFrameElement).contentDocument!.querySelectorAll(".wm-mermaid svg").length === 2);
  assert.equal(await phone.locator("#notice").isVisible(), false);
  for (const id of ["phone-comment", "comment"]) {
    const geometry = await phone.locator(`#${id}`).evaluate(button => {
      const box = button.getBoundingClientRect(), icon = button.querySelector("svg")!.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { width: box.width, height: box.height, dx: icon.x + icon.width / 2 - box.x - box.width / 2,
        dy: icon.y + icon.height / 2 - box.y - box.height / 2, background: style.backgroundColor, border: style.borderTopWidth };
    });
    assert.equal(geometry.width, 36); assert.equal(geometry.height, 36);
    assert(Math.abs(geometry.dx) < .5 && Math.abs(geometry.dy) < .5, `${id} icon is centered`);
    assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)");
    assert.equal(geometry.border, "1px");
  }
  assert.equal(await phone.locator(".ProseMirror").getAttribute("contenteditable"), "false");
  assert.equal(await phone.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content"), "yes");
  assert.deepEqual(await phone.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 375, height: 728 });
  assert.equal(await page.locator(".safari").isVisible(), false);
  assert.equal(await page.locator(".standalone-home").isVisible(), true);
  assert.deepEqual(await page.locator(".screen").evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight })), { width: 375, height: 812 });
  assert.equal(diagramRequests.length, 0, "Initial previews already use the selected theme");
  const hex = (rgb: string) => "#" + rgb.match(/\d+/g)!.slice(0, 3).map(value => Number(value).toString(16).padStart(2, "0")).join("");
  for (const theme of builtInThemes) {
    await chooseTheme(theme.value);
    await page.waitForFunction(primary => {
      const doc = (document.querySelector("#phone") as HTMLIFrameElement).contentDocument!;
      return doc.defaultView!.getComputedStyle(doc.documentElement).getPropertyValue("--wm-color-primary").trim() === primary;
    }, builtInDesign(theme.value)!.colors.primary);
    await page.waitForFunction(background => {
      const doc = (document.querySelector("#phone") as HTMLIFrameElement).contentDocument!;
      const svgs = [...doc.querySelectorAll(".wm-mermaid svg")];
      if (!svgs.length) return false;
      const probe = doc.createElement("span"); probe.style.color = background; doc.body.append(probe);
      const expected = doc.defaultView!.getComputedStyle(probe).color; probe.remove();
      return svgs.every(svg => doc.defaultView!.getComputedStyle(svg).backgroundColor === expected);
    }, builtInDesign(theme.value)!.colors.background);
    for (const pressed of [false, true]) {
      await phone.locator("#comment").evaluate((button, value) => button.setAttribute("aria-pressed", String(value)), pressed);
      for (const id of ["phone-comment", "comment"]) {
        const colors = await phone.locator(`#${id}`).evaluate(button => {
          const style = getComputedStyle(button);
          return { fill: style.backgroundColor, ink: style.color, page: getComputedStyle(document.body).backgroundColor };
        });
        const fill = hex(colors.fill);
        assert.equal(fill, builtInDesign(theme.value)!.colors[id === "comment" && pressed ? "inverse" : "primary"], `${theme.value}: theme button fill`);
        assert(contrastRatio(fill, hex(colors.page)) >= 3, `${theme.value}: button/page contrast`);
        assert(contrastRatio(fill, hex(colors.ink)) >= 3, `${theme.value}: icon/button contrast`);
      }
    }
    await phone.locator("#comment").evaluate(button => button.setAttribute("aria-pressed", "false"));
  }
  assert.equal(diagramRequests.length, builtInThemes.length - 1, "One batch per new palette; initial palette reused");
  assert.deepEqual(diagramLibraries, [], "Phone never downloads the Mermaid renderer");
  await chooseTheme("tether");
  await phone.locator('html[data-wm-theme="tether"]').waitFor();
  await page.reload();
  await phone.locator('html[data-wm-theme="tether"]').waitFor();
  assert.equal(await phone.locator('#theme-menu [data-theme="tether"]').getAttribute("aria-checked"), "true");
  await chooseTheme("tether-dark");
  await phone.locator('html[data-wm-theme="tether-dark"]').waitFor();
  await phone.locator("#phone-folio").click();
  const folio = phone.locator("#mobile-folio");
  await folio.getByRole("link", { name: "Folio navigation sample", exact: true }).click();
  await phone.locator(".ProseMirror h1").filter({ hasText: "Folio navigation sample" }).waitFor();
  assert.match(await page.locator("#phone").evaluate(frame => (frame as HTMLIFrameElement).contentWindow!.location.pathname), /^\/phone\/reader\/d\/[^/]+\/$/);
  await chooseTheme("tether");
  await phone.locator('html[data-wm-theme="tether"]').waitFor();
  await phone.locator("#phone-folio").click();
  await folio.getByRole("button", { name: "Archive", exact: true }).click();
  await folio.getByRole("link", { name: "Archived sample", exact: true }).click();
  await phone.locator(".ProseMirror h1").filter({ hasText: "Archived sample" }).waitFor();
  await phone.locator("#phone-folio").click();
  await folio.getByRole("link", { name: "Phone staging", exact: false }).click();
  await phone.locator(".wm-mermaid svg").first().waitFor();
  await chooseTheme("tether-dark");
  await phone.locator('html[data-wm-theme="tether-dark"]').waitFor();
  await page.screenshot({ path: "/tmp/tether-mini-standalone-preview.png" });
  await page.locator("#launch-mode").selectOption("safari");
  assert.deepEqual(await phone.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 375, height: 629 });
  assert.deepEqual(await page.locator(".screen").evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight })), { width: 375, height: 812 });
  const statusBounds = await page.locator(".ios-status").boundingBox();
  const pageBounds = await page.locator("#phone").boundingBox();
  const safariBounds = await page.locator(".safari").boundingBox();
  assert(statusBounds && pageBounds && safariBounds);
  assert(Math.abs(statusBounds.y + statusBounds.height - pageBounds.y) < 1);
  assert(Math.abs(pageBounds.y + pageBounds.height - safariBounds.y) < 1);
  await page.screenshot({ path: "/tmp/tether-mini-safari-preview.png" });
  await page.locator("#preset").selectOption("390,664");
  for (const percent of [83, 100, 125]) {
    await page.locator("#display-scale").fill(String(percent));
    await page.locator("#display-scale").dispatchEvent("change");
    assert.deepEqual(await phone.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 390, height: 664 });
    const displayed = await page.locator("#phone").boundingBox();
    assert(displayed);
    assert(Math.abs(displayed.width - 390 * percent / 100) < 1);
    assert(Math.abs(displayed.height - 664 * percent / 100) < 1);
  }
  await page.reload();
  assert.equal(await page.locator("#display-scale").inputValue(), "125", "Display calibration survives reloads");
  await phone.locator(".ProseMirror").waitFor();
  await page.locator("#display-scale").fill("83");
  await page.locator("#display-scale").dispatchEvent("change");
  await page.locator("#preset").selectOption("430,780");
  assert.deepEqual(await phone.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 430, height: 780 });
  await phone.locator(".ProseMirror p").first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await phone.locator("#phone-comment").click();
  const composer = phone.getByRole("textbox", { name: "Comment", exact: true });
  await composer.waitFor(); await composer.fill("Staging comment");
  await phone.getByRole("button", { name: "Comment", exact: true }).click();
  if (await phone.locator("#comment").getAttribute("aria-pressed") !== "true") await phone.locator("#comment").click();
  await phone.getByText("Staging comment", { exact: true }).first().waitFor();
  await page.screenshot({ path: "/tmp/tether-phone-stage-preview.png" });
  await page.locator("#session-tools summary").click();
  await page.locator("#expire").click();
  await phone.getByRole("button", { name: "Simulate passkey verification" }).click();
  await phone.locator(".ProseMirror").waitFor();
  assert.equal((await stageFetch("/theme", { method: "POST", headers: { origin: "https://elsewhere.invalid", "content-type": "application/json" }, body: JSON.stringify({ theme: "tether" }) })).status, 403);
  assert.equal((await stageFetch("/theme", { method: "POST", headers: { origin: stage.url, "content-type": "application/json" }, body: JSON.stringify({ theme: "invalid" }) })).status, 404);
  assert.equal((await stageFetch("/expire", { method: "POST", headers: { origin: "https://elsewhere.invalid" } })).status, 403);
  assert.equal((await stageFetch("/approval/enroll")).status, 403);
  assert.equal((await stageFetch("/phone/reader/api/file", { method: "PUT" })).status, 403);
  assert.deepEqual(errors, []);
  console.log("Phone staging passed: simulated sign-in, actual reader/gateway, viewport sizes, diagrams, comments, expiry recovery and request boundaries.");
} finally { await browser.close(); await stage.close(); if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }); }
