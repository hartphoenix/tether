import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Page } from "playwright";
import { startSettingsStage } from "./settings-stage";

const directory = await mkdtemp(join(tmpdir(), "tether-settings-stage-check-"));
const feedbackFile = join(directory, "feedback.json");
const stage = await startSettingsStage({ port: 0, feedbackFile });
const primary = "Where will you primarily use Tether?";
const paths = 'Should "copy file path" shortcuts in Tether include this computer’s name when pointing to its files?';
async function annotate(page: Page, target: string, note: string, send = true) {
  await page.getByRole("button", { name: "Start feedback mode", exact: true }).click();
  await page.locator(target).click();
  await page.locator("[data-annotation-popup] textarea").fill(note);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  if (send) {
    await page.getByRole("button", { name: "Send Annotations", exact: true }).click();
    await page.getByText(/^Saved \d+ notes across \d+ pages for your agent\.$/).waitFor();
  }
  await page.getByRole("button", { name: "Exit", exact: true }).click();
}
async function install(page: Page) {
  await page.waitForURL("**/fresh/setup/agent/");
  assert(!await page.locator("#general-settings").isVisible());
  await page.getByRole("button", { name: /^Allow progress reports/ }).click();
  await page.getByText(/Agent report \(unverified\): Ready to install/).waitFor();
  await page.getByRole("button", { name: "Run simulated installation" }).click();
  await page.waitForURL("**/fresh/setup/sign-in/");
  await page.getByRole("link", { name: "← Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Simulate passkey sign-in" }).click();
  await page.waitForURL("**/fresh/setup/verify/");
}
async function verify(page: Page, native = false, internet = false) {
  if (native) await page.locator('#fly-settings input[type="checkbox"]').first().check();
  if (internet) await page.getByLabel("I verified access from a browser", { exact: false }).check();
  await page.getByRole("button", { name: "Verify setup", exact: true }).click();
  await page.waitForURL("**/fresh/setup/complete/");
}
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", dialog => void dialog.accept());
      await page.goto(stage.url);
      await page.getByRole("button", { name: "Set up Tether Fly", exact: true }).click();
      await page.waitForURL("**/#fly/setup/access");
      assert.equal(context.pages().length, 1);
      assert(!await page.locator("#general-settings").isVisible(), "Setup must replace the Settings view");
      assert(!await page.locator("#settings-title").isVisible());
      assert.equal(await page.getByLabel(primary).locator("option").allTextContents() + "", "Paseo,cmux,Wave,Browser");
      assert.equal(await page.locator(".setup-help").evaluate(element => getComputedStyle(element).borderTopWidth), "0px");
      assert(await page.locator(".setup-help").evaluate(element => element.previousElementSibling?.textContent?.includes("Start with this computer")));
      await annotate(page, "#fly-settings h4", "App question feedback", false);
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.waitForURL("**/#fly/setup/qualifyPaths");
      await annotate(page, "#fly-settings h4", "Path question feedback");
      assert.equal(JSON.parse(await readFile(feedbackFile, "utf8"))["/fresh/settings/#fly/setup/access"].annotations[0].comment, "App question feedback", "Send includes other pages");
      await rm(feedbackFile);
      await page.reload();
      await page.getByText("Saved 2 notes across 2 pages for your agent.", { exact: true }).waitFor();
      await page.getByText("Step 2 of 3", { exact: true }).waitFor();
      await page.goBack(); await page.getByLabel(primary).waitFor();
      await page.goForward(); await page.getByLabel(paths).waitFor();
      await page.getByRole("link", { name: "← Settings", exact: true }).click();
      assert(await page.locator("#general-settings").isVisible());
      await page.getByRole("button", { name: "Set up Tether Fly", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByText("You will still need your passkey or password to sign in.", { exact: false }).waitFor();
      await page.getByLabel("Allow browser access from outside your private network?").selectOption("true");
      await page.getByRole("button", { name: "Prepare setup", exact: true }).click();
      await page.waitForURL("**/fresh/setup/agent/");
      assert((await page.getByLabel("Setup prompt").inputValue()).includes("File machine: Mac"));
      await page.getByRole("button", { name: "Change answers" }).click();
      await page.getByLabel(primary).selectOption("cmux");
      await page.reload();
      assert.equal(await page.getByLabel(primary).inputValue(), "cmux");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Run simulated installation" }).click();
      await page.getByText("Approve the setup agent’s progress reports first.", { exact: true }).waitFor();
      await install(page);
      await page.getByRole("button", { name: "Verify setup", exact: true }).click();
      await page.locator("#fly-feedback").filter({ hasText: "confirm" }).waitFor();
      await verify(page, true, true);
      await page.getByRole("button", { name: "All my computers are connected" }).waitFor();

      // Add another computer after the first installation; choose the hub only afterwards.
      await page.getByRole("button", { name: "Connect a machine or browser" }).click();
      await page.getByLabel(primary).selectOption("cmux");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByLabel("New machine name").fill("Staging server");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Prepare setup", exact: true }).click();
      await install(page);
      assert.equal(await page.getByLabel("Paseo client to verify").count(), 0);
      await verify(page, true);
      await page.getByRole("button", { name: "All my computers are connected" }).click();
      assert.equal(await page.locator(".hub-picker summary strong").textContent(), "Mac (this machine)");
      await page.locator(".hub-picker summary").click();
      assert(await page.getByRole("radio", { name: "Mac (this machine)", exact: true }).isChecked());
      await page.getByRole("radio", { name: "Staging server", exact: true }).check();
      await page.reload();
      assert.equal(await page.locator(".hub-picker summary").textContent(), "Staging server");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Change answers", exact: true }).last().click();
      assert.match(new URL(page.url()).hash, /^#fly\/attempt-\d+\/hub$/);
      await page.reload();
      assert.equal(await page.locator(".hub-picker summary").textContent(), "Staging server");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await install(page);
      await page.getByLabel("Document to verify").selectOption({ label: "/notes/connected-1.md" });
      await verify(page);
      await page.getByRole("button", { name: "All my computers are connected" }).click();
      assert.equal(await page.locator(".hub-picker summary strong").textContent(), "Staging server");
      await page.locator(".hub-picker summary").click();
      await page.getByRole("radio", { name: "Mac (this machine)", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();

      const feedback = JSON.parse(await readFile(feedbackFile, "utf8"));
      await page.getByRole("button", { name: "Reset to fresh install" }).click();
      await page.waitForURL("**/fresh/settings/");
      await page.getByRole("button", { name: "Set up Tether Fly", exact: true }).waitFor();
      assert.deepEqual(Object.keys(JSON.parse(await readFile(feedbackFile, "utf8"))), Object.keys(feedback));
      // Wave and browser setup both complete without requiring a Paseo client.
      for (const access of ["wave", "browser"]) {
        await page.getByRole("button", { name: "Set up Tether Fly", exact: true }).click();
        await page.getByLabel(primary).selectOption(access);
        await page.getByRole("button", { name: "Next", exact: true }).click();
        if (access === "wave") await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.getByRole("button", { name: "Prepare setup", exact: true }).click();
        await install(page); await verify(page, access === "wave");
        await page.getByRole("button", { name: "Reset to fresh install" }).click();
        await page.waitForURL("**/fresh/settings/");
      }
      await page.getByRole("link", { name: "Existing setup", exact: true }).click();
      await page.getByRole("button", { name: "All my computers are connected" }).click();
      await page.locator(".hub-picker summary").click();
      assert(await page.getByRole("radio", { name: "Travel laptop · Offline", exact: true }).isDisabled());
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByText("File machines (3)", { exact: true }).click();
      await page.getByRole("row", { name: /Travel laptop Offline Path only/ }).waitFor();
      assert.equal(await page.getByLabel("Machine name", { exact: true }).count(), 0);
      await page.getByRole("button", { name: "Edit Mac", exact: true }).click();
      await page.getByLabel("Machine name", { exact: true }).fill("Renamed Mac");
      await page.getByRole("button", { name: "Save machine", exact: true }).click();
      await page.getByText("Machine saved.", { exact: true }).waitFor();
      await page.getByRole("row", { name: /Renamed Mac Available Path only/ }).waitFor();
      await page.getByRole("button", { name: "Edit phoenix-bot", exact: true }).click();
      await page.getByLabel("Machine name", { exact: true }).fill("Discard this edit");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("row", { name: /phoenix-bot Available Machine \+ path/ }).waitFor();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.waitForURL("**/existing/setup/sign-in/");
      await page.getByRole("button", { name: "Simulate passkey sign-in" }).click();
      await page.waitForURL("**/existing/settings/");
      await page.getByText("File machines (3)", { exact: true }).click();
      await page.setViewportSize({ width: 375, height: 650 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert((await page.getByRole("button", { name: "Edit Renamed Mac", exact: true }).boundingBox())!.height < 40);
      await page.mouse.move(180, 350); await page.mouse.wheel(0, 800); await page.waitForFunction(() => scrollY > 0);
      assert.deepEqual(errors, []);
      await context.close();
    } finally { await browser.close(); }
  }
  assert.equal((await fetch(stage.url + "/fresh/api/stage/reset", { method: "POST", headers: { origin: "https://elsewhere.invalid" }, body: "{}" })).status, 403);
  console.log("Settings staging passed: Chromium/WebKit, full-page setup, all four app choices, multiple computers then hub selection, drafts/history, cross-page feedback, reset, machine editing and narrow scrolling.");
} finally { await stage.close(); await rm(directory, { recursive: true, force: true }); }
