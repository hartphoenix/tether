/**
 * Renders scripts/diagram-samples.md with Mermaid and with Pele in the real reader,
 * then writes screenshots and metrics. Usage:
 *   bun scripts/compare-diagram-renderers.ts [--out dir] [--themes a,b] [--widths 900,560,390] [--no-shots] [--webkit]
 */
import { chromium, webkit, type Page } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { createWebBundleResponder } from "../src/web/bundle";
import { builtInThemes } from "../src/shared/themes";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(flag("--out") ?? ".local/pele-demo");
const themes = flag("--themes")?.split(",") ?? builtInThemes.map(t => t.value);
const widths = (flag("--widths") ?? "900,560,390").split(",").map(Number);
const shots = !args.includes("--no-shots");
const renderers = ["mermaid", "pele"] as const;

const samples = await readFile("scripts/diagram-samples.md", "utf8");
const sources = [...samples.matchAll(/^## (.+)\n[\s\S]*?```mermaid\n([\s\S]*?)```/gm)].map(m => ({ title: m[1]!, source: m[2]! }));
const scratch = await mkdtemp(join(tmpdir(), "tether-diagrams-"));
const config = resolveConfig({ profile: "test", configDir: join(scratch, "config"), runtimeDir: join(scratch, "runtime") });
const daemon = createDaemon({ config, web: await createWebBundleResponder(), opener: async () => {} });
const docs = { mermaid: join(scratch, "mermaid.md"), pele: join(scratch, "pele.md") };
await writeFile(docs.mermaid, "---\ndiagrams: mermaid\n---\n" + samples);
await writeFile(docs.pele, "---\ndiagrams: pele\n---\n" + samples);

type DiagramMetric = { title: string; type: string; ok: boolean; bytes: number; elements: number; width: number; height: number; shown: number; labelPx: number };
const metrics: Record<string, unknown> = { date: new Date().toISOString(), diagrams: sources.length };

/** Code blocks initialize when visible, so walk each one into view. */
async function rendered(page: Page) {
  const blocks = page.locator(".milkdown-code-block");
  await blocks.nth(sources.length - 1).waitFor({ state: "attached" });
  for (let i = 0; i < sources.length; i++) {
    await blocks.nth(i).scrollIntoViewIfNeeded();
    await blocks.nth(i).locator(".wm-mermaid svg, .wm-mermaid-error").first().waitFor({ timeout: 30000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function measure(page: Page, renderer: string): Promise<DiagramMetric[]> {
  return page.evaluate(([titles, base]) => [...document.querySelectorAll(".milkdown-code-block")].map((block, i) => {
    const svg = block.querySelector<SVGSVGElement>(".wm-mermaid svg");
    const box = svg?.viewBox.baseVal;
    const shown = svg?.getBoundingClientRect().width ?? 0;
    const text = svg ? [...svg.querySelectorAll("text")].map(t => parseFloat(getComputedStyle(t).fontSize)).filter(Number.isFinite) : [];
    const median = text.sort((a, b) => a - b)[Math.floor(text.length / 2)] ?? base;
    return {
      title: titles[i] ?? String(i), type: svg?.getAttribute("aria-roledescription") ?? block.querySelector(".wm-pele")?.getAttribute("data-diagram") ?? "", ok: Boolean(svg),
      bytes: svg?.outerHTML.length ?? 0, elements: svg ? svg.querySelectorAll("*").length : 0,
      width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), shown: Math.round(shown),
      labelPx: box?.width ? +(median * shown / box.width).toFixed(1) : 0,
    };
  }), [sources.map(s => s.title), renderer === "pele" ? 15 : 16] as const);
}

const browser = await (args.includes("--webkit") ? webkit : chromium).launch();
try {
  await daemon.ready;
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const grants = { mermaid: await daemon.service.open(docs.mermaid), pele: await daemon.service.open(docs.pele) };
  // Each ticket is single-use; visit both once to set their cookies.
  for (const r of renderers) { await page.goto(daemon.mintTicket(grants[r]).url); await page.locator(".ProseMirror").waitFor(); }
  const urls = { mermaid: "", pele: "" };
  for (const r of renderers) { await page.goto(daemon.mintTicket(grants[r]).url); await page.locator(".ProseMirror").waitFor(); urls[r] = page.url(); }

  const setTheme = (theme: string) => page.evaluate(async theme => { await fetch("api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme }) }); }, theme);

  // Navigation until the first diagram is visible; the first run per renderer loads its chunk cold.
  const timing: Record<string, number[]> = { mermaid: [], pele: [] };
  for (let run = 0; run < 4; run++) for (const r of renderers) {
    const started = Date.now();
    await page.goto(urls[r]);
    await page.locator(".wm-mermaid svg").first().waitFor({ timeout: 30000 });
    timing[r]!.push(Date.now() - started);
  }
  metrics.firstDiagramMs = Object.fromEntries(renderers.map(r => [r, { cold: timing[r]![0], warmMedian: timing[r]!.slice(1).sort((a, b) => a - b)[1] }]));

  const perWidth: Record<string, Record<string, DiagramMetric[]>> = {};
  for (const width of widths) {
    perWidth[width] = {};
    await page.setViewportSize({ width, height: 900 });
    for (const r of renderers) {
      await page.goto(urls[r]);
      await rendered(page);
      perWidth[width]![r] = await measure(page, r);
    }
  }
  metrics.perWidth = perWidth;

  const contrast: Record<string, Record<string, number>> = {};
  if (shots) {
    await rm(join(out, "shots"), { recursive: true, force: true });
    for (const theme of themes) for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const r of renderers) {
        await page.goto(urls[r]);
        await setTheme(theme);
        await page.reload();
        await rendered(page);
        if (r === "pele" && width === widths[0]) contrast[theme] = await page.evaluate(contrastPairs);
        const dir = join(out, "shots", theme, String(width));
        await mkdir(dir, { recursive: true });
        const blocks = page.locator(".milkdown-code-block");
        for (let i = 0; i < sources.length; i++) {
          await blocks.nth(i).scrollIntoViewIfNeeded();
          await blocks.nth(i).screenshot({ path: join(dir, `${String(i + 1).padStart(2, "0")}-${r}.png`) });
        }
      }
    }
    await setTheme("tether");
    await contactSheets(page);
    metrics.contrast = contrast;
  }

  // Annotation parity: tap a node to select it, comment, and confirm the saved region.
  await page.setViewportSize({ width: 1400, height: 900 });
  const annotation: Record<string, unknown> = {};
  for (const r of renderers) {
    await page.goto(urls[r]);
    const block = page.locator(".milkdown-code-block").first();
    await block.locator(".wm-mermaid svg").waitFor();
    // A wide reading column lets Pele keep the left-to-right layout.
    await page.evaluate(() => document.documentElement.style.setProperty("--wm-lineWidth", "100ch"));
    if (r === "pele") await page.waitForFunction(() => document.querySelector<SVGSVGElement>(".wm-pele svg")!.viewBox.baseVal.width > 600);
    await block.hover();
    await block.locator(".wm-visual-comment").click();
    const dialog = page.locator("dialog.wm-diagram-viewer");
    await page.waitForFunction(() => document.querySelector(".wm-region-overlay")?.getAttribute("style")?.includes("pointer-events: auto"), undefined, { timeout: 15000 });
    const node = dialog.locator("svg :is(.pele-node, g.node)").filter({ hasText: "Write draft" }).first();
    const box = (await node.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const composer = dialog.locator(".wm-region-composer");
    const snapped = await composer.count() > 0;
    if (snapped) {
      await composer.locator("textarea").fill(`Snapped comment (${r})`);
      await composer.locator("button[type=submit]").click();
      await dialog.locator(".wm-visual-status", { hasText: "Saved" }).waitFor({ timeout: 15000 });
      await dialog.locator(".wm-visual-region").first().waitFor({ timeout: 15000 });
    }
    if (r === "pele") {
      // Draw around two nodes: the comment should name both and follow them through relayout.
      await dialog.locator(".wm-region-select").click();
      await page.waitForFunction(() => document.querySelector(".wm-region-overlay")?.getAttribute("style")?.includes("pointer-events: auto"));
      const boxes = await Promise.all(["Write draft", "Comment?"].map(text => dialog.locator("svg .pele-node").filter({ hasText: text }).first().boundingBox()));
      const [a, b] = boxes as { x: number; y: number; width: number; height: number }[];
      await page.mouse.move(Math.min(a!.x, b!.x) - 6, Math.min(a!.y, b!.y) - 6);
      await page.mouse.down();
      await page.mouse.move(Math.max(a!.x + a!.width, b!.x + b!.width) + 6, Math.max(a!.y + a!.height, b!.y + b!.height) + 6, { steps: 6 });
      await page.mouse.up();
      await composer.locator("textarea").fill("Drawn around two nodes");
      await composer.locator("button[type=submit]").click();
      await dialog.locator(".wm-visual-status", { hasText: "Saved" }).waitFor({ timeout: 15000 });
    }
    const region = snapped ? await dialog.locator(".wm-visual-region").first().evaluate(el => (el as HTMLElement).style.cssText) : null;
    const viewBox = await dialog.locator(".wm-diagram-stage > svg").first().getAttribute("viewBox");
    await dialog.screenshot({ path: join(out, `annotation-${r}.png`) });
    annotation[r] = { snapped, region, viewBox };
    await page.keyboard.press("Escape");
  }
  // Relayout: the same comment viewed at phone width, where Pele changes the layout.
  await page.setViewportSize({ width: 390, height: 900 });
  for (const r of renderers) {
    await page.goto(urls[r]);
    const block = page.locator(".milkdown-code-block").first();
    await block.locator(".wm-mermaid svg").waitFor();
    await page.waitForTimeout(500);
    if (r === "pele") {
      const drawn = await daemon.service.read(grants.pele);
      const threads = drawn.annotations.threads as { anchor: { visual?: { targets?: string[] } } }[];
      (annotation.pele as Record<string, unknown>).targets = threads.map(t => t.anchor.visual?.targets);
      (annotation.pele as Record<string, unknown>).drawnAt390 = await block.evaluate(b => {
        const regions = [...b.querySelectorAll(".wm-visual-regions .wm-visual-region")].map(el => el.getBoundingClientRect());
        const nodes = ["Write draft", "Comment?"].map(text => [...b.querySelectorAll("svg .pele-node")].find(n => n.textContent?.includes(text))!.getBoundingClientRect());
        const inside = (n: DOMRect, a: DOMRect) => n.left >= a.left - 1 && n.right <= a.right + 1 && n.top >= a.top - 1 && n.bottom <= a.bottom + 1;
        return regions.some(a => nodes.every(n => inside(n, a)));
      });
    }
    const placed = await block.evaluate(b => {
      const badge = b.querySelector(".wm-visual-regions .wm-visual-region");
      const node = [...b.querySelectorAll("svg :is(.pele-node, g.node)")].find(n => n.textContent?.includes("Write draft"));
      if (!badge || !node) return { badge: Boolean(badge), fallback: Boolean(b.querySelector(".wm-visual-fallback")), overlap: 0 };
      const a = badge.getBoundingClientRect(), n = node.getBoundingClientRect();
      const w = Math.max(0, Math.min(a.right, n.right) - Math.max(a.left, n.left)), h = Math.max(0, Math.min(a.bottom, n.bottom) - Math.max(a.top, n.top));
      return { badge: true, fallback: Boolean(b.querySelector(".wm-visual-fallback")), overlap: +(w * h / (n.width * n.height)).toFixed(2), viewBox: b.querySelector(".wm-mermaid svg")!.getAttribute("viewBox") };
    });
    await block.screenshot({ path: join(out, `annotation-${r}-390.png`) });
    (annotation[r] as Record<string, unknown>).at390 = placed;
  }
  metrics.annotation = annotation;

  // Library cost in isolation: identical sources, same page, no reader work.
  const bench = await Bun.build({ entrypoints: ["scripts/diagram-bench.ts"], target: "browser", format: "esm", minify: true });
  if (!bench.success) throw new Error(bench.logs.join("\n"));
  const script = await bench.outputs[0]!.text();
  await page.goto(urls.pele);
  await page.addScriptTag({ type: "module", content: script });
  await page.waitForFunction(() => "diagramBench" in window);
  metrics.renderMs = await page.evaluate(async sources => (window as any).diagramBench(sources), sources);

  metrics.bundle = await bundleCost();
  metrics.pageErrors = errors;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ out, annotation: metrics.annotation, firstDiagramMs: metrics.firstDiagramMs, bundle: metrics.bundle, errors: errors.length }, null, 2));
} finally {
  await browser.close();
  await daemon.stop?.();
  await rm(scratch, { recursive: true, force: true });
}

/** All chunks behind each library's dynamic import, from an isolated split build. */
async function bundleCost() {
  const result: Record<string, { files: number; bytes: number; gzip: number }> = {};
  for (const name of ["mermaid", "pele"]) {
    const dir = await mkdtemp(join(resolve("node_modules"), `.bundle-${name}-`));
    const entry = join(dir, "entry.ts");
    await writeFile(entry, `export const load = () => import(${JSON.stringify(name)});`);
    const built = await Bun.build({ entrypoints: [entry], outdir: join(dir, "out"), target: "browser", splitting: true, minify: true, root: dir });
    const chunks = built.outputs.filter(o => o.kind === "chunk");
    let bytes = 0, gzip = 0;
    for (const chunk of chunks) { const data = new Uint8Array(await chunk.arrayBuffer()); bytes += data.length; gzip += gzipSync(data).length; }
    result[name] = { files: chunks.length, bytes, gzip };
    await rm(dir, { recursive: true, force: true });
  }
  return result;
}

/** One image per theme and width: Mermaid on the left, Pele on the right. */
async function contactSheets(page: Page) {
  await mkdir(join(out, "sheets"), { recursive: true });
  const sheet = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  for (const theme of themes) for (const width of widths) {
    const dir = join(out, "shots", theme, String(width));
    const rows: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const cell = async (r: string) => `data:image/png;base64,${Buffer.from(await Bun.file(join(dir, `${String(i + 1).padStart(2, "0")}-${r}.png`)).arrayBuffer()).toString("base64")}`;
      rows.push(`<tr><th>${sources[i]!.title}</th><td><img src="${await cell("mermaid")}"></td><td><img src="${await cell("pele")}"></td></tr>`);
    }
    await sheet.setContent(`<style>body{margin:0;font:13px sans-serif;background:#888}table{border-collapse:collapse}th{writing-mode:vertical-rl;padding:4px}td{vertical-align:top;padding:4px}img{display:block;max-width:${Math.min(width, 700)}px}</style><table><tr><th></th><th style="writing-mode:initial">Mermaid</th><th style="writing-mode:initial">Pele</th></tr>${rows.join("")}</table>`);
    await sheet.screenshot({ path: join(out, "sheets", `${theme}-${width}.png`), fullPage: true });
  }
  await sheet.close();
}

/** WCAG contrast of Pele's resolved theme pairs, evaluated in the page. */
function contrastPairs() {
  const probe = document.createElement("span");
  document.body.append(probe);
  const rgb = (name: string) => {
    probe.style.color = `var(${name})`;
    const canvas = document.createElement("canvas").getContext("2d")!;
    canvas.fillStyle = getComputedStyle(probe).color;
    canvas.fillRect(0, 0, 1, 1);
    return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const luminance = (c: number[]) => { const [r, g, b] = c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r! + .7152 * g! + .0722 * b!; };
  const ratio = (a: string, b: string) => { const [x, y] = [luminance(rgb(a)), luminance(rgb(b))]; return +((Math.max(x, y) + .05) / (Math.min(x, y) + .05)).toFixed(2); };
  const result: Record<string, number> = {
    "text on node": ratio("--pele-fg", "--pele-surface"), "text on card": ratio("--pele-fg", "--pele-bg"), "muted on cluster": ratio("--pele-muted", "--pele-surface-alt"),
    "edge on card": ratio("--pele-line", "--pele-bg"), "border on card": ratio("--pele-border", "--pele-bg"),
  };
  for (let i = 1; i <= 8; i++) result[`series ${i} on card`] = ratio(`--pele-series-${i}`, "--pele-bg");
  probe.remove();
  return result;
}
