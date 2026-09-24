import { writeFile } from "node:fs/promises";
import { diagnostic } from "../shared/diagnostics";
import { startDaemon } from "./server";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../runtime-paths";
import { ensureDaemon } from "./lifecycle";
import { writeUpdateState } from "./updates";
import type { TetherConfig } from "./config";
import { resolveConfig } from "./config";
import { stopHostBridges } from "./stop-hosts";

export async function completeManagedUpdate(config: TetherConfig, root: string, tag: string, dependencies: {
  run?: (command: string[]) => Promise<number>;
  launch?: typeof ensureDaemon;
  signal?: AbortSignal;
} = {}): Promise<void> {
  let next = root;
  try {
    const command = [join(root, "mdreview"), "update", "--version", tag];
    dependencies.signal?.throwIfAborted();
    let code: number;
    if (dependencies.run) code = await dependencies.run(command);
    else {
      const child = Bun.spawn(command, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      // The updater can own an installer and unpacking subprocesses. Bound
      // their entire private process group so cancellation cannot leave a
      // late installer switching the runtime after the lifecycle decision.
      const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { if (child.exitCode === null) child.kill("SIGKILL"); } };
      const timer = setTimeout(stop, 120_000);
      dependencies.signal?.addEventListener("abort", stop, { once: true });
      try { code = await child.exited; }
      finally { clearTimeout(timer); dependencies.signal?.removeEventListener("abort", stop); }
    }
    if (code !== 0) throw new Error("Update failed");
  } catch {
    await writeUpdateState(config, { failed: true });
  }
  dependencies.signal?.throwIfAborted();
  // The installer can switch successfully before a later bookkeeping failure.
  next = await realpath(join(dirname(dirname(root)), "current")).catch(() => root);
  // Never fall back to an old executable after a new one has opened the database.
  await (dependencies.launch ?? ensureDaemon)({ config, signal: dependencies.signal, command: [join(next, "runtime/bun"), "--no-env-file", join(next, "lib/daemon.js")], env: { ...process.env, TETHER_INSTALL_ROOT: next } });
}

export async function runDaemon(options: { config?: TetherConfig; background?: boolean; ready?: () => Promise<void> } = {}): Promise<void> {
  const config = options.config ?? resolveConfig();
  let startupReport = process.env.TETHER_STARTUP_REPORT;
  delete process.env.TETHER_STARTUP_REPORT;
  const background = options.background ?? process.env.TETHER_BACKGROUND === "1";
  delete process.env.TETHER_BACKGROUND;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let terminating = false;
  let restarting = false;
  let update: string | undefined;
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const boundShutdown = () => { deadline ??= setTimeout(() => process.exit(1), 10_000); deadline.unref(); };
  const signal = () => {
    terminating = true; abort.abort(); boundShutdown();
    if (daemon) void daemon.stop().catch(() => process.exit(1));
  };
  for (const name of ["SIGTERM", "SIGINT"] as const) process.on(name, signal);
  try {
    daemon = await startDaemon({ config, background, publishStartup: async publish => {
      if (terminating) throw new Error("Startup interrupted.");
      await publish();
    }, restart: async () => {
      if (terminating || restarting || update) return;
      restarting = true;
      boundShutdown(); await daemon!.stop();
    }, quit: async () => {
      terminating = true; abort.abort(); boundShutdown();
      try { await stopHostBridges(config); } finally { await daemon!.stop(); }
    }, update: async tag => {
      if (terminating || restarting || update) throw new Error("A lifecycle operation is already pending.");
      update = tag;
      setTimeout(() => { boundShutdown(); void daemon!.stop().catch(() => process.exit(1)); }, 500);
    } });
    startupReport = undefined;
    await options.ready?.();
    if (terminating) await daemon.stop();
    await daemon.closed;
    clearTimeout(deadline); deadline = undefined;
    if (!terminating && update) {
      await completeManagedUpdate(config, runtimeRoot(), update, { signal: abort.signal });
    } else if (!terminating && restarting) {
      await ensureDaemon({ config, signal: abort.signal });
    } else {
      boundShutdown();
      await stopHostBridges(config);
    }
  } catch (cause) {
    if (startupReport) await writeFile(startupReport, JSON.stringify(diagnostic(cause)), { flag: "wx", mode: 0o600 }).catch(() => {});
    throw cause;
  } finally {
    clearTimeout(deadline);
    for (const name of ["SIGTERM", "SIGINT"] as const) process.off(name, signal);
  }
}

if (import.meta.main) {
  try { await runDaemon(); }
  catch (cause) { process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`); process.exit(1); }
}
