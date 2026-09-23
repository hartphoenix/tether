import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import type { TetherConfig } from "./config";

export async function runtimeFingerprint(root: string): Promise<string> {
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error("Startup requires an immutable, canonical installed runtime.");
  if (await realpath(join(dirname(dirname(root)), "current")) !== root) throw new Error("The installation changed. Re-enable startup for the current runtime.");
  const release = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  if (release.platform !== "darwin" || typeof release.version !== "string") throw new Error("Startup requires a packaged macOS release.");
  const paths = ["runtime/bun", "release.json", "mdreview", "tether"];
  for await (const path of new Bun.Glob("*.js").scan(join(root, "lib"))) paths.push(`lib/${path}`);
  for (const required of ["lib/login.js", "lib/daemon.js", "lib/cli.js", "lib/cmux-bridge.js"]) if (!paths.includes(required)) throw new Error("The package lacks guarded startup support.");
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error("Unsafe startup runtime file.");
    hash.update(path).update("\0").update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const startupLabel = (config: TetherConfig) => `local.tether.${config.profile}.${createHash("sha256").update(config.configDir).digest("hex").slice(0, 12)}`;

export function startupPlist(config: TetherConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(startupLabel(config))}</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(config.configDir, "login-guard.sh"))}</string></array>\n<key>RunAtLoad</key><true/>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}

/** This shell gate runs before Bun or application imports, and never loops.
 * The marker deliberately survives a bad runtime, broken import or SIGKILL. */
export function startupGuard(config: TetherConfig, root: string): string {
  return `#!/bin/sh\nset -eu\n[ ! -e ${quote(join(config.configDir, "startup-disabled"))} ] || exit 0\n[ -f ${quote(join(config.configDir, "automation.json"))} ] || exit 0\n/bin/mkdir -m 700 ${quote(join(config.configDir, "login-attempt"))} 2>/dev/null || exit 0\nexec /usr/bin/env -i HOME=${quote(process.env.HOME ?? "")} PATH=/usr/bin:/bin:/usr/sbin:/sbin TETHER_PROFILE=${quote(config.profile)} TETHER_CONFIG_DIR=${quote(config.configDir)} TETHER_RUNTIME_DIR=${quote(config.runtimeDir)} TETHER_INSTALL_ROOT=${quote(root)} ${quote(join(root, "runtime/bun"))} --no-env-file ${quote(join(root, "lib/login.js"))}\n`;
}

export function cmuxStartupHook(config: TetherConfig, root: string): string {
  return `# Source from an interactive cmux shell only; no credentials are written.\nif [ -n "\${CMUX_SOCKET_CAPABILITY:-}" ] && [ -n "\${CMUX_SOCKET_PATH:-}" ] && [ ! -e ${quote(join(config.configDir, "startup-disabled"))} ]; then\n  (if /bin/mkdir -m 700 ${quote(join(config.configDir, "attach-attempt"))} 2>/dev/null; then\n    TETHER_PROFILE=${quote(config.profile)} TETHER_CONFIG_DIR=${quote(config.configDir)} TETHER_RUNTIME_DIR=${quote(config.runtimeDir)} ${quote(join(root, "mdreview"))} cmux attach >/dev/null 2>&1\n  fi &)\nfi\n`;
}
