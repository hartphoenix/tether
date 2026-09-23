// Keep this entry independent of application/SQLite imports until the durable
// attempt exists. A failed import must leave automation latched across logins.
import { resolveConfig, acquireStartupLock } from "./config";
import { beginAttempt, readAutomation } from "./automation-state";
import { runtimeFingerprint } from "./startup-assets";
import { rmdir } from "node:fs/promises";
import { join } from "node:path";

export async function loginStart(): Promise<void> {
  const config = resolveConfig();
  const state = await readAutomation(config);
  if (!state.enabled || !state.runtime) return;
  const digest = await runtimeFingerprint(state.runtime.root);
  if (digest !== state.runtime.digest) throw new Error("The enabled startup runtime changed. Automatic startup remains blocked.");
  let lock: Awaited<ReturnType<typeof acquireStartupLock>>;
  for (let attempt = 0; ; attempt++) {
    try { lock = await acquireStartupLock(config); break; }
    catch (cause) { if ((cause as { code?: string }).code !== "writer_busy" || attempt >= 200) throw cause; await Bun.sleep(100); }
  }
  let released = false;
  const release = async () => { if (!released) { released = true; await lock.release(); } };
  try {
    const { discoverDaemon } = await import("./lifecycle");
    if (await discoverDaemon(config)) {
      if (!(await readAutomation(config)).daemon) await rmdir(join(config.configDir, "login-attempt")).catch(cause => { if (cause.code !== "ENOENT") throw cause; });
      return;
    }
    const attempt = await beginAttempt(config, "daemon", state.runtime);
    const { runDaemon } = await import("./daemon");
    await runDaemon({ config, attempt, ready: release });
  } finally { await release(); }
}

if (import.meta.main) {
  try { await loginStart(); }
  catch { process.stderr.write("Tether automatic startup did not complete; inspect startup status before re-enabling.\n"); process.exitCode = 1; }
}
