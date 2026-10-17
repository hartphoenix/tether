import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

let registered = false;
let library: unknown;
/** Register only our bundled background executable, with activation prohibited. */
export async function registerMacIdentity(): Promise<void> {
  if (registered || process.platform !== "darwin") return;
  const executable = realpathSync(process.execPath);
  if (!executable.endsWith("/tether.app/Contents/MacOS/tether")) return;
  const path = join(dirname(executable), "../Frameworks/tether-identity.dylib");
  if (!existsSync(path)) throw new Error("Tether's native service identity is missing; repair the service installation.");
  const { dlopen } = await import("bun:ffi");
  const loaded = dlopen(path, { tether_register_identity: { args: [], returns: "void" } });
  loaded.symbols.tether_register_identity();
  library = loaded; // Keep AppKit's registration code loaded for the process lifetime.
  registered = true;
}
