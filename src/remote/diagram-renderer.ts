import type { DiagramPalette } from "../shared/diagram-theme";
import { chromium, type Browser, type Page } from "playwright";

export interface DiagramRenderer {
  render(source: string, dark: boolean, palette?: DiagramPalette): Promise<string>;
  close(): Promise<void>;
}

const MAX_SOURCE_BYTES = 50 * 1024, MAX_SVG_BYTES = 2 * 1024 * 1024;
const CACHE_ENTRIES = 32, CACHE_BYTES = 16 * 1024 * 1024, TIMEOUT_MS = 10_000;
// DM Mono, normal 400, latin subset (see src/web/fonts.css).
const FONT_PATH = `${import.meta.dir}/../web/fonts/dmmono-9.woff2`;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:";

class RenderTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => {}); // A timed-out evaluation rejects later, when its browser closes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RenderTimeout("Diagram render timed out")), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Host-side Mermaid rendering in a sandboxed, offline headless Chromium. Requires a source checkout. */
export async function createDiagramRenderer(): Promise<DiagramRenderer> {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/diagram-page.ts`], target: "browser", format: "esm", splitting: false, minify: true });
  if (!build.success || build.outputs.length !== 1) throw new AggregateError(build.logs, "Diagram page build failed");
  const bundle = await build.outputs[0]!.text();
  const font = Buffer.from(await Bun.file(FONT_PATH).arrayBuffer()).toString("base64");
  const fontFace = `@font-face{font-family:"Tether Diagram Mono";font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${font}) format("woff2")}`;
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style id="tether-diagram-font">${fontFace}</style></head><body></body></html>`;

  let browser: Browser | undefined, page: Promise<Page> | undefined;
  let queue: Promise<unknown> = Promise.resolve(), closed = false, generation = 0;
  const cache = new Map<string, string>(); let cacheBytes = 0;

  async function shutdown() {
    const current = browser; browser = undefined; page = undefined; generation++;
    await current?.close().catch(() => {});
  }
  async function openPage(): Promise<Page> {
    const opening = generation;
    // Playwright disables Chromium's sandbox unless asked; keep it on.
    const launched = await chromium.launch({ headless: true, chromiumSandbox: true });
    // A launch that outlived a timeout or close() must not leave an orphaned process.
    if (opening !== generation) { await launched.close(); throw new Error("Diagram renderer was reset"); }
    browser = launched;
    const context = await launched.newContext({ offline: true, serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", route => route.abort());
    const created = await context.newPage();
    await created.setContent(html);
    await created.addScriptTag({ content: bundle, type: "module" });
    await created.waitForFunction(() => typeof (globalThis as any).tetherRender === "function");
    return created;
  }
  async function renderFresh(source: string, dark: boolean, palette?: DiagramPalette): Promise<string> {
    page ??= openPage();
    const current = page;
    try {
      const svg = await withTimeout(current.then(p => p.evaluate(([s, d, palette]) => (globalThis as any).tetherRender(s, d, palette) as Promise<string>, [source, dark, palette] as const)), TIMEOUT_MS);
      if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error("Rendered diagram is too large");
      return svg;
    } catch (error) {
      // Mermaid errors leave the page usable; timeouts, crashes, and launch failures do not.
      const broken = error instanceof RenderTimeout || !browser?.isConnected() || (await current.then(p => p.isClosed(), () => true));
      if (broken && page === current) await shutdown();
      throw error;
    }
  }
  function remember(key: string, svg: string) {
    cache.set(key, svg); cacheBytes += key.length + svg.length;
    while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
      const [oldKey, oldSvg] = cache.entries().next().value!;
      cache.delete(oldKey); cacheBytes -= oldKey.length + oldSvg.length;
    }
  }

  return {
    render(source, dark, palette) {
      if (closed) return Promise.reject(new Error("Diagram renderer is closed"));
      if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return Promise.reject(new Error("Diagram source is too large"));
      const key = `${JSON.stringify(palette ?? dark)}\n${source}`;
      const result = queue.catch(() => {}).then(async () => {
        if (closed) throw new Error("Diagram renderer is closed");
        const cached = cache.get(key);
        if (cached !== undefined) { cache.delete(key); cache.set(key, cached); return cached; }
        const svg = await renderFresh(source, dark, palette);
        remember(key, svg);
        return svg;
      });
      queue = result;
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      await shutdown();
    },
  };
}
