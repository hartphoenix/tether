import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpath, readFile, writeFile, rename, rm } from "node:fs/promises";
import { runtimeRoot } from "../runtime-paths";
import { hostCommand, type HostInventory } from "./host-discovery";
import { versionAtLeast } from "../hosts/version";

/** The plugin needs Paseo 0.11.2 APIs. Later releases install normally; Tether never sets an upper bound. */
export const MINIMUM_PASEO_VERSION = "0.11.2";
export const TESTED_PASEO_VERSION = "0.11.2";

type Plugin = { id: string; path: string; enabled: boolean; status: string };
export type PaseoSetupOptions = { root?: string; home?: string; run?: typeof hostCommand };

/** Directory paths are retained lexically by Paseo 0.11.2, so `current` follows updates. */
async function managedPath(root: string): Promise<string> {
  const path = resolve(dirname(dirname(root)), "current/integrations/paseo");
  if (await realpath(path) !== await realpath(join(root, "integrations/paseo"))) throw new Error("Paseo setup requires the selected packaged installation.");
  return path;
}

export async function setupPaseo(host: HostInventory, options: PaseoSetupOptions = {}) {
  if (!host.cli) throw new Error("Paseo CLI was not found. Install Paseo before adding its Tether plugin.");
  const stable = host.version?.match(/^(\d+\.\d+\.\d+)(?:[-+]|$)/)?.[1];
  if (stable && !versionAtLeast(stable, MINIMUM_PASEO_VERSION)) throw new Error(`The Tether plugin requires Paseo ${MINIMUM_PASEO_VERSION} or later; detected ${host.version}. Update Paseo first.`);
  if (!options.root && !process.env.TETHER_INSTALL_ROOT) throw new Error("Managed Paseo setup requires a packaged Tether installation.");
  const path = await managedPath(options.root ?? runtimeRoot());
  const home = resolve(options.home ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo"));
  const run = options.run ?? hostCommand;
  const command = (...args: string[]) => run(host.cli!, ["plugin", ...args, "--home", home, "--json"]);
  const plugins: Plugin[] = JSON.parse(await command("ls"));
  if (!Array.isArray(plugins)) throw new Error("Invalid Paseo plugin inventory.");
  const current = plugins.find(plugin => plugin.id === "tether");
  if (current && current.path !== path) throw new Error("An unmanaged Tether plugin is already configured in Paseo; preserved. Review it before replacing it.");
  // An explicit rerun refreshes the bundle but never enables a disabled plugin.
  const result: Plugin = current ? current.enabled && current.status !== "disabled" ? JSON.parse(await command("reload", "tether")) : current : JSON.parse(await command("install", path));
  const receipt = resolve(dirname(dirname(options.root ?? runtimeRoot())), "paseo-installation.json");
  const temporary = `${receipt}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ path, home }) + "\n", { mode: 0o600 });
  await rename(temporary, receipt);
  return { path, installed: !current, status: result.status, enabled: result.enabled, testedPaseo: TESTED_PASEO_VERSION,
    ...(stable === TESTED_PASEO_VERSION ? {} : { note: `Tested with Paseo ${TESTED_PASEO_VERSION}; detected ${host.version ?? "an unknown version"}. If a Paseo change breaks panels, turn off custom Tether panels in Settings → Tether.` }),
    themes: ["Tether Light", "Tether Dark", "Light Treason", "Dark Academia"],
    next: result.status === "disabled" ? "Enable plugins in Paseo Settings → Plugins when ready. Tether left the global switch unchanged." : "The plugin follows Tether package updates. Reload it in Paseo after updating to activate the new code." };
}

/** Remove only the exact managed registration; never remove another installation. */
export async function removeManagedPaseo(host: HostInventory, options: PaseoSetupOptions = {}): Promise<boolean> {
  const receipt = resolve(dirname(dirname(options.root ?? runtimeRoot())), "paseo-installation.json");
  const saved = await readFile(receipt, "utf8").then(JSON.parse).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
  if (!saved) return false;
  if (!host.cli) throw new Error("Paseo is unavailable. Remove the managed Tether plugin in Paseo before uninstalling Tether.");
  const path = await managedPath(options.root ?? runtimeRoot());
  if (saved.path !== path || typeof saved.home !== "string") throw new Error("Paseo installation record changed; preserved.");
  const run = options.run ?? hostCommand;
  const flags = ["--home", saved.home, "--json"];
  const plugins: Plugin[] = JSON.parse(await run(host.cli, ["plugin", "ls", ...flags]));
  if (!plugins.some(plugin => plugin.id === "tether" && plugin.path === path)) return false;
  await run(host.cli, ["plugin", "remove", "tether", ...flags]);
  await rm(receipt);
  return true;
}
