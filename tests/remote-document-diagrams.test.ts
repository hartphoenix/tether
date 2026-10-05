import { expect, test } from "bun:test";
import { documentDiagrams } from "../src/remote/document-diagrams";

test("previews include only Mermaid blocks from the supplied document and isolate render failures", async () => {
  const calls: string[] = [];
  const renderer = { close: async () => {}, render: async (source: string) => {
    calls.push(source);
    if (source === "broken") throw new Error("invalid diagram");
    return "<svg/>";
  } };
  const body = "```mermaid\nA --> B\n```\n\n```js\nnotADiagram()\n```\n\n```mermaid\nA --> B\n```\n\n```mermaid\nbroken\n```";
  expect(await documentDiagrams(body, renderer)).toEqual({ "A --> B": "<svg/>", broken: null });
  expect(calls).toEqual(["A --> B", "broken"]);
});

test("oversized diagram sources are not sent to the host renderer", async () => {
  let called = false;
  const source = "a".repeat(51 * 1024);
  const previews = await documentDiagrams(`\`\`\`mermaid\n${source}\n\`\`\``, { close: async () => {}, render: async () => { called = true; return "<svg/>"; } });
  expect(called).toBe(false);
  expect(previews[source]).toBeNull();
});

test("document previews pass the palette to the host and deduplicate repeated blocks", async () => {
  const palette = { dark: true, background: "#101010", surface: "#202020", surfaceLow: "#303030", ink: "#ffffff", outline: "#888888", line: "#cccccc" };
  const calls: unknown[] = [];
  const renderer = { close: async () => {}, render: async (...args: unknown[]) => { calls.push(args); return "<svg/>"; } };
  await documentDiagrams("```mermaid\nA --> B\n```\n```mermaid\nA --> B\n```", renderer, palette);
  expect(calls).toEqual([["A --> B", true, palette]]);
});

test("diagram palette accepts only bounded hex colors and discards arbitrary configuration", async () => {
  const { parseDiagramPalette, diagramPalette } = await import("../src/shared/diagram-theme");
  const { builtInDesign } = await import("../src/shared/themes");
  const palette = diagramPalette(builtInDesign("tether-dark")!.colors, true);
  expect(parseDiagramPalette({ ...palette, securityLevel: "loose", source: "untrusted" })).toEqual(palette);
  expect(() => parseDiagramPalette({ ...palette, ink: "url(https://example.com)" })).toThrow();
  expect(() => parseDiagramPalette({ ...palette, dark: "true" })).toThrow();
});

test("mobile SVG batches stop at four MiB and honor cancellation", async () => {
  let calls = 0;
  const renderer = { close: async () => {}, render: async () => { calls++; return "x".repeat(2 * 1024 * 1024); } };
  const body = ["a", "b", "c"].map(source => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n");
  const previews = await documentDiagrams(body, renderer);
  expect(calls).toBe(2);
  expect(previews.c).toBeNull();
  const controller = new AbortController(); controller.abort();
  await expect(documentDiagrams(body, renderer, undefined, controller.signal)).rejects.toThrow();
  expect(calls).toBe(2);
});
