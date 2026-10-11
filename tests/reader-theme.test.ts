import { expect, test } from "bun:test";
import { themedReaderHtml } from "../src/server/reader-theme";
import { builtInDesign } from "../src/shared/themes";

const page = () => new Response('<!doctype html><html lang="en"><head></head><body></body></html>', { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

test("the reader's first frame uses its light theme instead of the stylesheet's dark default", async () => {
  const themed = themedReaderHtml(page(), { theme: "tether", customThemes: [] });
  const html = await themed.text();
  const light = builtInDesign("tether")!;
  expect(html).toContain('data-wm-theme="tether"');
  expect(html).toContain(`color-scheme:light;--wm-page-background:${light.colors.background};--wm-page-color:${light.colors["on-background"]}`);
  expect(themed.headers.get("cache-control")).toBe("no-store");
});

test("custom themes paint their own colors on their base; unsafe values are left out", async () => {
  const design = { ...builtInDesign("tether-dark")!, id: "custom-mine" as const, name: "Mine", colors: { ...builtInDesign("tether-dark")!.colors, background: "#102030", "on-background": "red;}" } };
  const html = await themedReaderHtml(page(), { theme: "custom-mine", customThemes: [design] }).text();
  expect(html).toContain('data-wm-theme="tether-dark"');
  expect(html).toContain('style="color-scheme:dark;--wm-page-background:#102030"');
});
