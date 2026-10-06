import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Hub } from "./server/hub";
import { paseoLookup } from "./server/paseo-lookup";
import { ProcessPool } from "./server/process-pool";
import { createTetherRunner, resolveTether } from "./server/tether-cli";
import { ackRpc, folioViewRpc, openRpc, openNoticeRpc, pinRpc, pumpRpc, themeRpc, tetherSettings, type Connection, type PumpBatch } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(tetherSettings);
  const pool = new ProcessPool();
  type Session = { connection: Connection; controller: AbortController; hub: Hub };
  let current: Session | null = null;
  let disposed = false, subscribed = false, buttons = true;
  const clear = () => {
    const previous = current;
    current = null;
    previous?.hub.stop();
    previous?.controller.abort();
  };
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (disposed) return;
    if (state.status !== "ready") { clear(); return; }
    const values = state.values;
    buttons = values.buttons;
    if (current?.connection.tetherPath === values.tetherPath && current.connection.profile === values.profile) {
      current.hub.presentationChanged();
      return;
    }
    clear();
    const connection = { generation: crypto.randomUUID(), tetherPath: values.tetherPath, profile: values.profile };
    const controller = new AbortController();
    const hub = new Hub({
      connection,
      run: createTetherRunner({ binary: () => resolveTether(connection.tetherPath), profile: () => connection.profile, signal: controller.signal, pool }),
      buttons: () => buttons,
    });
    current = { connection, controller, hub };
    hub.start();
  };
  let initialized!: () => void;
  const loaded = new Promise<void>(resolve => { initialized = resolve; });
  const unsubscribe = settings.subscribe(state => { subscribed = true; apply(state); initialized(); });
  void settings.read().then(state => { if (!subscribed) apply(state); initialized(); }, () => { initialized(); });
  const unavailable = (error = "Tether connection settings are unavailable. Check plugin settings."): PumpBatch => ({
    connection: null, revision: -1, folio: null, intents: [], notices: {}, buttons,
    status: { connected: false, tether: null, error },
  });
  const attach = (session: Session, { paseo }: PluginHandlerContext) => session.hub.attach(paseoLookup(paseo));
  const requireSession = (generation?: string) => {
    if (!generation) throw new Error("Tether plugin changed. Reload Paseo to update this view.");
    if (!current) throw new Error("Tether connection settings are unavailable.");
    if (generation !== current.connection.generation) throw new Error("Tether connection settings changed. Retry from the current view.");
    return current;
  };
  const operate = async <T>(input: { generation?: string; tetherPath?: string; profile?: string }, run: (session: Session) => Promise<T>) => {
    await loaded;
    const session = requireSession(input.generation);
    if ((input.tetherPath !== undefined && input.tetherPath !== session.connection.tetherPath) || (input.profile !== undefined && input.profile !== session.connection.profile)) throw new Error("Tether connection settings changed. Retry from the current view.");
    const result = await run(session);
    if (current !== session) throw new Error("Tether connection changed. The command may already have completed; check before retrying.");
    return result;
  };

  server.handle(pumpRpc, async (input, context) => {
    await loaded;
    if (input.generation === undefined) {
      // Older pumps immediately retry successful responses; keep their reload notice
      // useful without creating a tight RPC loop during an upgrade.
      await new Promise(resolve => setTimeout(resolve, 1000));
      return unavailable("Tether plugin changed. Reload Paseo to update this view.");
    }
    const session = current;
    if (!session) return unavailable();
    attach(session, context);
    const result = await session.hub.pump(input.generation === session.connection.generation ? input.revision : -1, input.executor);
    // A stopped Hub wakes old polls; never forward its cached state or launch leases.
    if (current !== session) return current ? current.hub.pump(-1, false) : unavailable();
    return result;
  });
  server.handle(ackRpc, input => operate(input, async ({ hub }) => ({ acknowledged: await hub.ack(input.ids) })));
  server.handle(openRpc, (input, context) => operate(input, async session => { attach(session, context); await session.hub.open(input.documentId ? `id:${input.documentId}` : input.path!, input.workspaceId); return { queued: true }; }));
  server.handle(openNoticeRpc, input => operate(input, async ({ hub }) => { await hub.openNotice(input.documentId, input.workspaceId); return { queued: true }; }));
  server.handle(pinRpc, input => operate(input, async ({ hub }) => { await hub.pin(input.documentId ? `id:${input.documentId}` : input.path!, input.pinned); return { pinned: input.pinned }; }));
  server.handle(themeRpc, input => operate(input, ({ hub }) => hub.theme(input.clientId, input.theme)));
  server.handle(folioViewRpc, input => operate(input, ({ hub }) => hub.folioView(input.workspaceId)));

  server.before("agent.session_open", ({ request }) => request.workspaceId
    ? { ...request, env: { ...request.env, TETHER_PASEO_WORKSPACE_ID: request.workspaceId } }
    : undefined);
  return () => { disposed = true; clear(); initialized(); unsubscribe(); };
}
