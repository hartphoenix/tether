import { resolve } from "node:path";

/** Installed launchers set an absolute, version-specific root before startup. */
export function runtimeRoot(): string {
  return process.env.TETHER_INSTALL_ROOT ?? resolve(import.meta.dir, "..");
}

export function runtimeEntry(entry: "cli" | "daemon" | "wave-bridge" | "cmux-bridge"): string {
  const root = runtimeRoot();
  if (process.env.TETHER_INSTALL_ROOT) return resolve(root, "lib", `${entry}.js`);
  return resolve(root, entry === "cli" ? "mdreview" : entry === "daemon" ? "src/server/daemon.ts" : `src/hosts/${entry}-daemon.ts`);
}
