import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaseoPlugin } from "../scripts/build-paseo-plugin";

test("the staged plugin shares Paseo's React Query context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tether-plugin-build-"));
  try {
    await buildPaseoPlugin(directory, "0.0.0");
    const client = await Bun.file(join(directory, "index.client.ts")).text();
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(client);
    expect(imports.some(({ path }) => path === "@tanstack/react-query")).toBe(true);
    expect(client).not.toContain("No QueryClient set, use QueryClientProvider to set one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
