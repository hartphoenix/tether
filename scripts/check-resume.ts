import { chromium, webkit, type BrowserContext, type Page } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, type TetherDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { controlRecentsAdd, controlRecentsLaunch } from "../src/server/lifecycle";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function loaded(page: Page) {
  await page.locator(".ProseMirror").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#editor")!.inert);
}
async function wake(page: Page) {
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
}

// Independent browser profiles; never quits or automates the user's host.
for (const browser of [chromium, webkit]) {
  const directory = await mkdtemp(join(tmpdir(), "tether-resume-"));
  let daemon: TetherDaemon | undefined;
  let context: BrowserContext | undefined;
  try {
    const path = join(directory, "reader.md");
    const original = "# Resume fixture\n\n" + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: saved text.\n\n`).join("");
    await writeFile(path, original);
    const config = resolveConfig({ profile: "resume", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
    daemon = await startDaemon({ config });
    const profile = join(directory, "browser");
    context = await browser.launchPersistentContext(profile, { headless: true });
    const page = await context.newPage();
    let attempts = 0;
    await page.route("**/api/bootstrap", async route => {
      attempts++;
      if (attempts < 3) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"message":"starting"}}' });
      else await route.continue();
    });
    const grant = await daemon.service.open(path);
    await page.goto(daemon.mintTicket(grant).url);
    await loaded(page);
    check(attempts === 3, "bootstrap did not retry automatically");
    check(await page.locator(".ProseMirror").count() === 1, "duplicate editor after retry");
    const readerUrl = page.url();
    const bootstrap = await page.evaluate(async () => (await fetch("api/bootstrap")).json());
    await page.evaluate(() => document.querySelector<HTMLElement>(".wm-document-scroll")!.scrollTop = 1200);
    await page.waitForTimeout(300);
    // Pause/resume through BFCache signals without destroying the mounted UI.
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await wake(page);
    await page.locator("#comment").click();
    check(await page.locator("#comment").getAttribute("aria-pressed") === "true", "UI destroyed during cached-page suspension");
    const folio = await context.newPage();
    await folio.goto((await controlRecentsLaunch(config)).url);
    await folio.waitForFunction(() => document.querySelector("#list")?.getAttribute("aria-busy") === "false");
    const folioUrl = folio.url();
    const cookies = await context.cookies();
    check(cookies.filter(c => c.name.startsWith("tether_")).every(c => c.expires > Date.now() / 1000), "session-only browser cookie");
    await page.close();
    // A real persisted conflicted draft, not a fabricated bootstrap response.
    const draft = original.replace("saved text", "my recovered edit");
    const savedDraft = await context.request.post(new URL("api/draft", readerUrl).href, {
      headers: { origin: daemon.origin }, data: { body: draft, baseRevision: bootstrap.document.bodyRevision, scroll: 1200 },
    });
    check(savedDraft.ok(), "draft setup failed");
    const disk = original.replace("saved text", "external edit");
    await writeFile(path, disk);
    await context.close(); context = undefined;
    // Agent registration remains usable while no browser/host views are alive.
    const queued = join(directory, "queued.md"); await writeFile(queued, "# Queued while closed\n");
    await controlRecentsAdd(config, queued);
    await daemon.stop();
    daemon = await startDaemon({ config });
    context = await browser.launchPersistentContext(profile, { headless: true });
    const restored = await context.newPage();
    let bootstraps = 0, leaseFailures = 0;
    await restored.route("**/api/bootstrap", async route => { bootstraps++; await route.continue(); });
    await restored.route("**/api/lease", async route => {
      if (leaseFailures++ === 0) await route.abort(); else await route.continue();
    });
    await restored.goto(readerUrl);
    await loaded(restored);
    check((await restored.locator(".ProseMirror").innerText()).includes("my recovered edit"), "draft lost across browser restart");
    check(await restored.locator("#conflict").isVisible(), "conflicting draft was not flagged");
    check(await restored.evaluate(() => document.querySelector<HTMLElement>(".wm-document-scroll")!.scrollTop) > 1000, "reading position lost during initialization");
    await wake(restored); // Network failure AFTER mounting/recovering the editor.
    await restored.waitForTimeout(1000);
    check(bootstraps === 1, "post-mount failure reran bootstrap");
    check((await restored.locator(".ProseMirror").innerText()).includes("my recovered edit"), "reconnect replaced dirty editor");
    check(await readFile(path, "utf8") === disk, "recovery overwrote external edits");
    const restoredFolio = await context.newPage(); await restoredFolio.goto(folioUrl);
    await restoredFolio.getByText("queued.md", { exact: true }).waitFor();
    // Already-loaded pages recover after service replacement at the saved origin.
    await daemon.stop(); await wake(restored);
    daemon = await startDaemon({ config });
    await wake(restored); await wake(restoredFolio);
    await restored.waitForFunction(() => !document.querySelector("#notice")?.textContent?.startsWith("Disconnected"));
    check(bootstraps === 1, "daemon replacement rebuilt dirty editor");
    console.log(`${browser.name()}: persistent cookies, bootstrap retry, draft/conflict/scroll recovery, cached-page UI, queue, and daemon reconnect passed.`);
  } finally {
    await context?.close(); await daemon?.stop(); await rm(directory, { recursive: true, force: true });
  }
}
