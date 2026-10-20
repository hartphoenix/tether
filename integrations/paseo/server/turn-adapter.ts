import type { TetherRunner } from "./tether-cli";
import { connectTurnHost } from "./turn-sdk";
import { connectTurnTransport } from "./turn-transport";
import { TurnDispatcher, waitForTurnConnection } from "./turn-dispatcher";

/** One host-owned connection, restarted automatically without agent turns. */
export function startTurnAdapter(run: TetherRunner, connection: string, lifetime: AbortSignal) {
  const instance = crypto.randomUUID();
  let stage = "host", connections = 0;
  let connected: { hostId: string; transport: Awaited<ReturnType<typeof connectTurnTransport>> } | undefined;
  let dispatcher: TurnDispatcher | undefined;
  const done = (async () => {
    let backoff = 500;
    while (!lifetime.aborted) {
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime, controller.signal]);
      let timer: ReturnType<typeof setInterval> | undefined;
      let host: Awaited<ReturnType<typeof connectTurnHost>> | undefined;
      let off = () => {};
      let release = async () => {};
      try {
        stage = "host"; host = await connectTurnHost();
        signal.throwIfAborted();
        stage = "tether";
        const transport = await connectTurnTransport(run, connection, signal);
        stage = "lease";
        let lease = await transport.command({ action: "lease", hostId: host.hostId, instance });
        connections++;
        connected = { hostId: host.hostId, transport };
        release = async () => { await transport.command({ action: "release", hostId: host!.hostId, token: lease.token }, AbortSignal.timeout(1500)).catch(() => {}); };
        dispatcher = new TurnDispatcher(host, transport, () => lease.token, signal, undefined, () => controller.abort());
        off = host.disconnected(() => controller.abort());
        let renewing = false;
        timer = setInterval(() => {
          if (renewing || signal.aborted) return;
          renewing = true;
          void transport.command({ action: "lease", hostId: host!.hostId, instance }).then(value => { lease = value; }, () => controller.abort()).finally(() => { renewing = false; });
        }, 15_000);
        backoff = 500; stage = "events";
        await transport.events(host.hostId, snapshot => dispatcher?.update(snapshot));
      } catch { /* Fixed diagnostics elsewhere; never log credentials or raw errors. */ }
      finally {
        connected = undefined; controller.abort(); clearInterval(timer); off(); dispatcher?.stop(); dispatcher = undefined;
        await release();
        await host?.close().catch(() => {});
      }
      if (!lifetime.aborted) await waitForTurnConnection(backoff, lifetime);
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
  return { done, status: () => ({ connected: !!connected, stage, connections, ...(connected ? { hostId: connected.hostId } : {}) }), behavior: async (hostId: string, agentId: string, behavior: "steer" | "interrupt" | "queue") => {
    if (!connected || connected.hostId !== hostId) throw new Error("Paseo turn adapter is reconnecting.");
    await connected.transport.command({ action: "behavior", hostId, agentId: `paseo:${agentId}`, behavior });
    return { updated: true };
  }, wake: (agentId: string) => dispatcher?.wake(`paseo:${agentId}`) };
}
