import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const destination = resolve(root, ".local/prototypes/paseo-delivery/plugin");
await mkdir(destination, { recursive: true });
const common = { target: "browser" as const, external: ["@getpaseo/plugin", "@getpaseo/plugin/client", "react", "react-native", "zod"], outdir: destination };
const client = await Bun.build({ ...common, entrypoints: [resolve(root, "integrations/paseo/prototype/index.client.ts")] });
const server = await Bun.build({ ...common, target: "node", entrypoints: [resolve(root, "integrations/paseo/prototype/index.server.ts")], define: {
  PROBE_BUN: JSON.stringify(process.execPath),
  PROBE_SERVICE: JSON.stringify(resolve(root, "scripts/paseo-delivery-service.ts")),
  PROBE_DATABASE: JSON.stringify(resolve(root, ".local/prototypes/paseo-delivery/delivery-prototype.sqlite")),
} });
if (!client.success || !server.success) throw new Error([...client.logs, ...server.logs].join("\n"));
// Paseo's directory plugin loader discovers source entrypoint extensions.
await copyFile(resolve(destination, "index.client.js"), resolve(destination, "index.client.ts"));
await copyFile(resolve(destination, "index.server.js"), resolve(destination, "index.server.ts"));
await writeFile(resolve(destination, "paseo-plugin.json"), JSON.stringify({ id: "tether-delivery-prototype", requirements: { paseo: ">=0.11.2 <0.11.3" } }, null, 2));
await writeFile(resolve(destination, "package.json"), JSON.stringify({ name: "tether-delivery-prototype", version: "0.0.0", private: true, type: "module", dependencies: { "@getpaseo/plugin": "0.11.2", zod: "^4.4.3" } }, null, 2));
await copyFile(resolve(root, "integrations/paseo/prototype/NOTICE.md"), resolve(destination, "NOTICE.md"));
console.log(`Staged only; nothing installed or reloaded: ${destination}`);
