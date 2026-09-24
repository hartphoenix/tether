import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TetherConfig } from "./config";

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const startupLabel = (config: TetherConfig) => `local.tether.${config.profile}.${createHash("sha256").update(config.configDir).digest("hex").slice(0, 12)}`;
export const cmuxHookPath = (config: TetherConfig) => join(config.configDir, "cmux-startup.sh");
/** launchd appends the login job's output here; it only writes on failure. */
export const startupLogPath = (config: TetherConfig) => join(config.configDir, "login.log");

/** Runs the installation's `current` release once per login. launchd provides
 * the bound: no KeepAlive, so a failed start waits for the next login. */
export function startupPlist(config: TetherConfig, installBase: string): string {
  const current = join(installBase, "current");
  const environment = { TETHER_PROFILE: config.profile, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(startupLabel(config))}</string>
<key>ProgramArguments</key><array><string>${xml(join(current, "runtime/bun"))}</string><string>--no-env-file</string><string>${xml(join(current, "lib/login.js"))}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>StandardOutPath</key><string>${xml(startupLogPath(config))}</string>
<key>StandardErrorPath</key><string>${xml(startupLogPath(config))}</string>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

/** Sourced by interactive cmux shells. It passes the shell's own cmux authority
 * to a short-lived attach command; nothing is written to disk. */
export function cmuxStartupHook(config: TetherConfig, installBase: string): string {
  const mdreview = join(installBase, "current", "mdreview");
  return `# Tether cmux attachment. Source from an interactive shell; stores no credentials.
if [ -n "\${CMUX_SOCKET_CAPABILITY:-}" ] && [ -n "\${CMUX_SOCKET_PATH:-}" ] && [ -x ${quote(mdreview)} ]; then
  (TETHER_PROFILE=${quote(config.profile)} TETHER_CONFIG_DIR=${quote(config.configDir)} TETHER_RUNTIME_DIR=${quote(config.runtimeDir)} ${quote(mdreview)} cmux attach >/dev/null 2>&1 &)
fi
`;
}
