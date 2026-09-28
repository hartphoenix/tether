import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Hub } from "./server/hub";
import { paseoLookup } from "./server/paseo-lookup";
import { createTetherRunner, resolveTether } from "./server/tether-cli";
import { ackRpc, folioViewRpc, openRpc, pinRpc, pumpRpc, themeRpc, tetherSettings, type TetherSettings } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(tetherSettings);
  let current: TetherSettings = tetherSettings.schema.parse({});
  let ready = false;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    ready = state.status === "ready";
    if (state.status === "ready") current = state.values;
  };
  const unsubscribe = settings.subscribe(apply);
  const loaded = settings.read().then(apply, () => {});

  const hub = new Hub({
    run: createTetherRunner({ binary: () => resolveTether(current.tetherPath), profile: () => current.profile }),
    buttons: () => current.buttons,
  });
  void loaded.then(() => hub.start());
  const withPaseo = ({ paseo }: PluginHandlerContext) => hub.attach(paseoLookup(paseo));

  server.handle(pumpRpc, (input, context) => { withPaseo(context); return hub.pump(input.revision, input.executor); });
  server.handle(ackRpc, async input => ({ acknowledged: await hub.ack(input.ids) }));
  server.handle(openRpc, async (input, context) => { withPaseo(context); await hub.open(input.path, input.workspaceId); return { queued: true }; });
  server.handle(pinRpc, async input => { await hub.pin(input.path, input.pinned); return { pinned: input.pinned }; });
  server.handle(themeRpc, async input => {
    await loaded;
    if (!ready || input.tetherPath !== current.tetherPath || input.profile !== current.profile) throw new Error("Tether connection settings changed. Retry theme sync.");
    return hub.theme(input.clientId, input.theme);
  });
  server.handle(folioViewRpc, async input => {
    await loaded;
    if (!ready) throw new Error("Tether connection settings are unavailable.");
    if (input.tetherPath !== current.tetherPath || input.profile !== current.profile) throw new Error("Tether connection settings changed. Retry Folio.");
    return hub.folioView(input.workspaceId);
  });

  // Agents inherit their workspace so an agent's `tether open` reaches the right button.
  server.before("agent.session_open", ({ request }) => request.workspaceId
    ? { ...request, env: { ...request.env, TETHER_PASEO_WORKSPACE_ID: request.workspaceId } }
    : undefined);

  return () => {
    hub.stop();
    unsubscribe();
  };
}
