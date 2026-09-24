// launchd entry. Starts this profile's daemon unless one is already running;
// the daemon then lives in this job and stops with the login session.
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { resolveConfig, acquireStartupLock } from "./config";

export async function loginStart(): Promise<void> {
  // Packaged as <release>/lib/login.js; launchd reaches it through `current`.
  if (basename(import.meta.dir) === "lib") process.env.TETHER_INSTALL_ROOT ??= await realpath(resolve(import.meta.dir, ".."));
  const config = resolveConfig();
  let lock: Awaited<ReturnType<typeof acquireStartupLock>>;
  for (let attempt = 0; ; attempt++) {
    try { lock = await acquireStartupLock(config); break; }
    catch (cause) { if ((cause as { code?: string }).code !== "writer_busy" || attempt >= 200) throw cause; await Bun.sleep(100); }
  }
  let released = false;
  const release = async () => { if (!released) { released = true; await lock.release(); } };
  try {
    const { discoverDaemon } = await import("./lifecycle");
    // Login is busy: a daemon that survived logout may answer slowly at first.
    for (let attempt = 0; ; attempt++) {
      try { if (await discoverDaemon(config)) return; break; }
      catch (cause) { if (attempt >= 20) throw cause; await Bun.sleep(500); }
    }
    const { runDaemon } = await import("./daemon");
    await runDaemon({ config, background: true, ready: release });
  } finally { await release(); }
}

if (import.meta.main) {
  try { await loginStart(); }
  catch (cause) {
    const { diagnosticText } = await import("../shared/diagnostics");
    process.stderr.write(`${new Date().toISOString()} Tether login startup did not complete: ${diagnosticText(cause instanceof Error ? cause.message : String(cause))}. Run \`tether\` to start it manually.\n`);
    process.exitCode = 1;
  }
}
