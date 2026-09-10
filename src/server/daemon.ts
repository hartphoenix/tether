import { startDaemon } from "./server";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../runtime-paths";
import { ensureDaemon } from "./lifecycle";
import { writeUpdateState } from "./updates";
import type { TetherConfig } from "./config";

export async function completeManagedUpdate(config: TetherConfig, root: string, tag: string, dependencies: {
  run?: (command: string[]) => Promise<number>;
  launch?: typeof ensureDaemon;
} = {}): Promise<void> {
  let next = root;
  try {
    const command = [join(root, "mdreview"), "update", "--version", tag];
    const code = dependencies.run ? await dependencies.run(command) : await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited;
    if (code !== 0) throw new Error("Update failed");
  } catch {
    await writeUpdateState(config, { failed: true });
  }
  // The installer can switch successfully before a later bookkeeping failure.
  next = await realpath(join(dirname(dirname(root)), "current")).catch(() => root);
  // Never fall back to an old executable after a new one has opened the database.
  await (dependencies.launch ?? ensureDaemon)({ config, command: [join(next, "runtime/bun"), join(next, "lib/daemon.js")], env: { ...process.env, TETHER_INSTALL_ROOT: next } });
}

if (import.meta.main) {
  let restart = true;
  while (restart) {
    restart = false;
    let update: string | undefined;
    const daemon = await startDaemon({ restart: async () => {
      restart = true;
      await daemon.stop();
    }, update: async tag => {
      update = tag;
      // Let the HTTP acceptance reach Folio before closing the listener.
      setTimeout(() => { void daemon.stop(); }, 500);
    } });
    await daemon.closed;
    if (update) {
      // Start the selected runtime, preserving the listener and scoped views.
      await completeManagedUpdate(daemon.config, runtimeRoot(), update);
      break;
    }
    if (restart) {
      // A new process reloads backend modules as well as the browser bundle.
      await ensureDaemon({ config: daemon.config });
      break;
    }
  }
}
