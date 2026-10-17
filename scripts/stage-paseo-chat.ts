import { resolve } from "node:path";
import { buildPaseoPlugin } from "./build-paseo-plugin";
const destination = resolve(process.argv[2] ?? ".local/builds/paseo-v1/plugin");
await buildPaseoPlugin(destination, "0.0.0");
console.log(`Staged Tether for Paseo 0.11.2: ${destination}\nNothing installed or reloaded.`);
