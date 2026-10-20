/** Real browser check against a disposable authority; no host agent or model runs. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";

const directory = await mkdtemp("/tmp/tether-go-reader-");
const path = join(directory, "document.md");
await writeFile(path, "# Go reader\n\nA disposable document.\n");
const daemon = await startDaemon({ config: resolveConfig({ profile: "go-reader", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") }), keepAlive: true, persistentViews: false });
const browser = await chromium.launch();
try {
  const grant = await daemon.service.open(path), documentId = grant.documentId!;
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const requests: string[] = [], errors: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(daemon.mintTicket(grant).url);
  const empty = page.locator('.wm-turn-agent[data-state="none"] .wm-turn-button');
  await empty.waitFor({ state: "attached" });
  if (!await empty.isVisible()) await page.locator("#comment").click();
  await empty.click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes("--if-empty"));
  await daemon.turnOperation("register", { path, actor: "Reader fixture", agentId: "paseo:fixture", hostId: "fixture-host" });
  const button = page.locator('.wm-turn-agent[data-state="ready"] .wm-turn-button');
  await button.waitFor({ state: "attached" });
  // The comments drawer contains Go on small screens.
  if (!await button.isVisible()) await page.locator("#comment").click();
  await button.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy role takeover prompt" }).click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes("--role-id 'paseo:fixture'"));
  assert.equal(daemon.hostTurns.snapshot("local", "fixture-host").signals.length, 0);
  await page.locator(".wm-turn-caption").filter({ hasText: "Reader fixture" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename agent…" }).click();
  await page.getByRole("textbox", { name: "Agent name", exact: true }).fill("Renamed role");
  await page.getByRole("textbox", { name: "Agent name", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Take the next turn: Renamed role", exact: true }).waitFor();
  await daemon.turnOperation("takeover", { path, roleId: "paseo:fixture", expectedRecipient: "paseo:fixture", agentId: "paseo:replacement", hostId: "fixture-host" });
  await button.click();
  await page.locator('.wm-turn-agent[data-state="queued"]').waitFor();
  const signal = daemon.hostTurns.snapshot("local", "fixture-host").signals[0]!;
  assert.equal(signal.documentId, documentId); assert.equal(signal.agentId, "paseo:fixture");
  assert.equal(signal.recipientId, "paseo:replacement");
  await page.reload();
  await page.locator('.wm-turn-agent[data-state="queued"]').waitFor({ state: "attached" });
  const lease = daemon.hostTurns.lease("local", "fixture-host", "reader-check");
  daemon.hostTurns.update("local", "fixture-host", lease.token, signal.signalId, "claim");
  daemon.hostTurns.update("local", "fixture-host", lease.token, signal.signalId, "accepted");
  await page.locator('.wm-turn-agent[data-state="working"]').waitFor({ state: "attached" });
  daemon.hostTurns.update("local", "fixture-host", lease.token, signal.signalId, "completed");
  await button.waitFor({ state: "attached" });
  assert(requests.some(path => path.endsWith("/api/turn-events")));
  assert(!requests.some(path => path.endsWith("/api/turns")), "Go status must use events, not polling");
  assert.deepEqual(errors, []);
  console.log("Go reader passed: empty-slot clipboard, role takeover clipboard, caption rename, replacement recipient, mobile-width press, reload recovery, live completion and no Go polling.");
} finally { await browser.close(); await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
