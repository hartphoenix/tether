import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { waveInstallationDetected, type WaveLauncherOptions } from "../hosts/wave-launchers";

export type HostInventory = { id: "paseo" | "cmux" | "wave"; installed: boolean; cli: string | null; version: string | null; active: boolean; connected: boolean | null };
export async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }

/** Bounded subprocesses without a shell; output is never forwarded from host tools. */
export async function hostCommand(executable: string, args: string[]): Promise<string> {
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); throw new Error("Host command output exceeded its limit."); }
      chunks.push(chunk);
    }
    if (await child.exited !== 0) throw new Error("Host command failed; check the host's connection and plugin settings.");
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); }
}

export async function discoverHosts(options: { home?: string; applicationRoots?: string[]; which?: (name: string) => string | null; run?: typeof hostCommand; wave?: WaveLauncherOptions; paseoConnected?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<HostInventory[]> {
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  const roots = options.applicationRoots ?? ["/Applications", join(home, "Applications")];
  const which = options.which ?? (name => Bun.which(name));
  const run = options.run ?? hostCommand;
  const specs = [
    { id: "paseo" as const, app: "Paseo.app", command: "paseo", bundled: "Contents/Resources/bin/paseo", active: Boolean(env.TETHER_PASEO_WORKSPACE_ID), connected: options.paseoConnected ?? false },
    { id: "cmux" as const, app: "cmux.app", command: "cmux", bundled: "Contents/Resources/bin/cmux", active: Boolean(env.CMUX_WORKSPACE_ID), connected: null },
    { id: "wave" as const, app: "Wave.app", command: "wsh", bundled: "Contents/Resources/app/bin/wsh", active: env.WAVETERM === "1" || env.TERM_PROGRAM === "waveterm", connected: null },
  ];
  return Promise.all(specs.map(async spec => {
    let cli = which(spec.command), app: string | undefined;
    for (const root of roots) if (await exists(join(root, spec.app))) { app = join(root, spec.app); break; }
    if (!cli && app && await exists(join(app, spec.bundled))) cli = join(app, spec.bundled);
    let version: string | null = null;
    try {
      const output = app ? await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents/Info.plist")]) : cli ? await run(cli, ["--version"]) : "";
      version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null;
    } catch { /* Installed and callable are separate facts. */ }
    const installed = Boolean(app || cli || spec.active || (spec.id === "wave" && await waveInstallationDetected(options.wave)));
    return { id: spec.id, installed, cli, version, active: spec.active, connected: spec.connected };
  }));
}
