import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";

test("six reader turn streams leave browser connections available for Folio and reader requests", async () => {
  const directory = await mkdtemp("/tmp/tether-turn-connections-");
  const path = join(directory, "document.md");
  await writeFile(path, "# Connection test\n");
  const daemon = createDaemon({ config: resolveConfig({ profile: "test", configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") }), web: () => new Response("<!doctype html><title>Connection test</title>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    await daemon.ready;
    const page = await browser.newPage();
    await page.goto(daemon.mintTicket(await daemon.service.open(path)).url);
    const result = await page.evaluate(async () => {
      const streams: EventSource[] = [];
      try {
        await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
          const source = new EventSource("api/turn-events"); streams.push(source);
          const timer = setTimeout(() => reject(new Error("Turn snapshot timed out")), 4000);
          source.addEventListener("turns", () => { clearTimeout(timer); resolve(); }, { once: true });
        })));
        const response = await fetch("api/bootstrap", { signal: AbortSignal.timeout(4000) });
        return response.status;
      } finally { streams.forEach(source => source.close()); }
    });
    expect(result).toBe(200);
  } finally { await browser.close(); await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
}, 15000);
