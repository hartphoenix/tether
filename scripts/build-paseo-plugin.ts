import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** A self-contained directory plugin; Paseo supplies the external runtime modules. */
export async function buildPaseoPlugin(destination: string, version: string): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  await mkdir(destination, { recursive: true });
  const external = ["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native", "react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod"];
  for (const [entry, target, name] of [["index.client.tsx", "browser", "index.client.ts"], ["index.server.ts", "node", "index.server.ts"]] as const) {
    const build = await Bun.build({ entrypoints: [resolve(root, "integrations/paseo", entry)], target, external, jsx: { runtime: "automatic", development: false }, define: { "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const source = await build.outputs[0].text();
    if (target === "browser") {
      const unsupported = new Bun.Transpiler({ loader: "js" }).scanImports(source).filter(({ path }) => !external.includes(path));
      if (unsupported.length) throw new Error(`Unsupported Paseo client imports: ${unsupported.map(({ path }) => path).join(", ")}`);
    }
    await writeFile(resolve(destination, name), source);
  }
  for (const [source, name] of [["LICENSE", "LICENSE"], ["integrations/paseo/paseo-plugin.json", "paseo-plugin.json"], ["integrations/paseo/chat/NOTICE.md", "NOTICE.md"]]) {
    await copyFile(resolve(root, source!), resolve(destination, name!));
  }
  await writeFile(resolve(destination, "package.json"), JSON.stringify({ name: "tether", version, private: true, type: "module" }, null, 2) + "\n");
}
