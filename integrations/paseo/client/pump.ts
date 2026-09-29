import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ackRpc, pumpRpc } from "../shared/contracts";
import { acceptBatch, disconnect, getState, hasOpener, runOrHold, sourceKey, type Delivery } from "./state";
import { isDesktop } from "./web";

export const FOLIO_PANEL = "folio";

/**
 * The installation's one connection to the plugin server. It mirrors hub
 * state into the client store and carries out reader intents. With no Folio
 * panel mounted, it reveals the intent's workspace Folio, which then opens
 * the tab; the hub's lease covers that delay. Returns cleanup.
 */
export function startPump(client: PluginClientContext): () => void {
  let stopped = false;
  const acknowledge = (intent: Delivery) => {
    void client.rpc(ackRpc, { ids: [intent.id], generation: intent.generation }).catch(() => {});
  };
  void (async () => {
    let revision = -1;
    let backoff = 1_000;
    while (!stopped) {
      try {
        const batch = await client.rpc(pumpRpc, { revision, generation: getState().connection?.generation ?? null, executor: hasOpener() || isDesktop() });
        if (stopped) break;
        revision = batch.revision;
        acceptBatch(batch);
        if (!batch.connection) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        for (const intent of batch.intents) {
          if (!runOrHold({ ...intent, generation: batch.connection.generation, source: sourceKey() }, acknowledge)) client.openPanel(FOLIO_PANEL, { workspaceId: intent.workspaceId, location: "explorer" });
        }
        backoff = 1_000;
      } catch {
        if (stopped) break;
        disconnect();
        revision = -1;
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  })();
  return () => { stopped = true; };
}
