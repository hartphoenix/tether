import { chromium, webkit, type Page } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { createWebBundleResponder } from "../src/web/bundle";

const root = await mkdtemp("/tmp/tether-code-annotations-");
const daemon = createDaemon({ config: resolveConfig({ runtimeDir: join(root, "runtime"), configDir: join(root, "config") }), web: await createWebBundleResponder() });
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function selectInLine(page: Page, index: number, width: number) {
  const box = (await page.locator(".cm-line").nth(index).boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + width, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

try {
  await daemon.ready;
  await mkdir(join(root, "docs"));
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]] as const) {
    const path = join(root, "docs", `${name}.md`);
    await writeFile(path, "# Code\n\nProse.\n\n```js\nconst alpha = 1;\nconst beta = 2;\n```\n");
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
      await page.waitForSelector(".milkdown-code-block .cm-content");
      const lineHeight = (await page.locator(".cm-line").first().boundingBox())!.height;

      await selectInLine(page, 0, 80);
      const visible = await page.evaluate(() => {
        const line = document.querySelector(".cm-line.cm-activeLine");
        const selection = document.querySelector(".cm-selectionBackground");
        return Boolean(selection?.getBoundingClientRect().width) && (!line || getComputedStyle(line).backgroundColor === "rgba(0, 0, 0, 0)");
      });
      check(visible, `${name}: code selection is hidden behind the active line`);

      await page.locator(".wm-code-comment-toolbar [data-toolbar-item=comment]").dispatchEvent("pointerdown");
      await page.locator(".wm-comment-popover textarea").fill("a note");
      await page.getByRole("button", { name: "Comment", exact: true }).last().click();
      await page.waitForSelector(".cm-line .wm-annotation-highlight");
      await page.waitForSelector(".cm-line .wm-annotation-count");
      check(!(await page.locator(".cm-selectionBackground").count()), `${name}: the commented code stayed selected after saving`);
      check((await page.locator(".cm-line").first().boundingBox())!.height === lineHeight, `${name}: the comment badge changed the code line height`);

      for (const target of [".cm-line .wm-annotation-highlight", ".cm-line .wm-annotation-count"]) {
        await page.locator(target).first().click();
        await page.locator(".wm-thread-popover").waitFor({ state: "visible" });
        await page.locator(".wm-thread-popover").getByRole("button", { name: "Close" }).click();
        await page.locator(".wm-thread-popover").waitFor({ state: "hidden" });
      }
      console.log(`${name}: code selection, highlight, badge, and thread opening passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
