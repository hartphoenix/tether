import { sourceRevision } from "./build-revision";
import { SetupAttempts } from "../remote/setup-attempts";
import { readSharedConfig, writeSharedConfig, startSharedProfile } from "./shared-profile";
import type { TetherDaemon } from "./server";

/** Called only after local control-token or scoped local Folio-cookie verification. */
export async function localFlySettings(daemon: TetherDaemon, action: string, body: Record<string, unknown>): Promise<unknown> {
  const attempts = new SetupAttempts(daemon.service.store.db);
  if (action === "attempt") return attempts.save(body.answers, typeof body.id === "string" ? body.id : undefined);
  if (action === "configure") {
    if (daemon.shared) throw new Error("The hub is already configured. Stop it before changing its HTTPS origin.");
    const config = { origin: String(body.origin), port: Number(body.port), owner: "Tether owner", active: true };
    // Starting the loopback app alone never enables internet exposure.
    const shared = await startSharedProfile(daemon, config);
    try { await writeSharedConfig(daemon.config, config); }
    catch (cause) { await shared.stop(); throw cause; }
    daemon.shared = shared;
    return shared.localControl("status", {});
  }
  if (daemon.shared) return daemon.shared.localControl(action, body);
  if (action === "status") return { configured: false, sourceRevision: await sourceRevision(), enabled: false, origin: (await readSharedConfig(daemon.config))?.origin ?? null,
    localMachineId: daemon.service.store.localMachineId, machines: daemon.service.store.machines.list(), clients: [], attempts: attempts.list() };
  throw Object.assign(new Error("Configure the hub’s HTTPS endpoint through the setup agent first."), { code: "shared_not_configured", status: 409 });
}
