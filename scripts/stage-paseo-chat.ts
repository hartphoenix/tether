import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, ".."), destination = resolve(root, ".local/builds/paseo-v1/plugin");
await mkdir(destination, { recursive: true });
const external = ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native", "react", "react/jsx-runtime", "react-native", "zod"];
for (const [entry, target, name] of [["index.client.tsx", "browser", "index.client.ts"], ["index.server.ts", "node", "index.server.ts"]] as const) {
  // Paseo exposes jsx-runtime, but not Bun's default development JSX runtime.
  const build = await Bun.build({ entrypoints: [resolve(root, "integrations/paseo", entry)], target, external, jsx: { runtime: "automatic", development: false }, define: { "process.env.NODE_ENV": '"production"' } });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const source = await build.outputs[0].text();
  if (target === "browser") {
    // Keep the final artifact within Paseo 0.11.2's client runtime boundary.
    const unsupported = new Bun.Transpiler({ loader: "js" }).scanImports(source).filter(({ path }) => !external.includes(path));
    if (unsupported.length) throw new Error(`Unsupported Paseo client imports: ${unsupported.map(({ path }) => path).join(", ")}`);
  }
  await writeFile(resolve(destination, name), source);
}
await copyFile(resolve(root, "LICENSE"), resolve(destination, "LICENSE"));
await copyFile(resolve(root, "integrations/paseo/paseo-plugin.json"), resolve(destination, "paseo-plugin.json"));
await copyFile(resolve(root, "integrations/paseo/chat/NOTICE.md"), resolve(destination, "NOTICE.md"));
await writeFile(resolve(destination, "package.json"), JSON.stringify({ name: "tether", version: "0.0.0", private: true, type: "module", dependencies: { "@getpaseo/plugin": "0.11.2", zod: "^4.4.3" } }, null, 2) + "\n");
console.log(`Staged Tether v1 for Paseo 0.11.2: ${destination}\nUses the Tether executable/profile configured in plugin settings. Nothing installed or reloaded.`);
