import { startTurnAdapter } from "./server/turn-adapter";
import { sharedTransport } from "./server/transport";
import { registerChat, runChat } from "./chat/server";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Hub } from "./server/hub";
import { paseoLookup } from "./server/paseo-lookup";
import { ProcessPool } from "./server/process-pool";
import { createTetherRunner, resolveTether } from "./server/tether-cli";
import { turnStatusRpc, turnBehaviorRpc, ackRpc, folioViewRpc, openRpc, openNoticeRpc, pinRpc, pumpRpc, themeRpc, tetherSettings, type Connection, type PumpBatch } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(tetherSettings);
  const pool = new ProcessPool();
  type Session = { sharedConnection: string; connection: Connection; controller: AbortController; hub: Hub; turns: ReturnType<typeof startTurnAdapter> };
  let current: Session | null = null;
  let disposed = false, subscribed = false, buttons = true, readerPanels = false;
  const clear = () => {
    const previous = current;
    current = null;
    previous?.hub.stop();
    previous?.controller.abort();
    return previous?.turns.done;
  };
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (disposed) return;
    if (state.status !== "ready") { clear(); return; }
    const values = state.values;
    buttons = values.buttons;
    readerPanels = values.readerPanels;
    if (current?.connection.tetherPath === values.tetherPath && current.connection.profile === values.profile && current.sharedConnection === values.sharedConnection) {
      current.hub.presentationChanged();
      return;
    }
    clear();
    const connection = { generation: crypto.randomUUID(), tetherPath: values.tetherPath, profile: values.profile, shared: !!values.sharedConnection };
    const controller = new AbortController();
    const run = createTetherRunner({ binary: () => resolveTether(connection.tetherPath), profile: () => connection.profile, signal: controller.signal, pool });
    const hub = new Hub({
      connection,
      run,
      ...(values.sharedConnection ? { transport: sharedTransport(run, values.sharedConnection) } : {}),
      buttons: () => buttons,
      readerPanels: () => readerPanels,
    });
    current = { connection, controller, hub, sharedConnection: values.sharedConnection, turns: startTurnAdapter(run, values.sharedConnection, controller.signal) };
    hub.start();
  };
  let initialized!: () => void;
  const loaded = new Promise<void>(resolve => { initialized = resolve; });
  const unsubscribe = settings.subscribe(state => { subscribed = true; apply(state); initialized(); });
  void settings.read().then(state => { if (!subscribed) apply(state); initialized(); }, () => { initialized(); });
  const unavailable = (error = "Tether connection settings are unavailable. Check plugin settings."): PumpBatch => ({
    connection: null, revision: -1, folio: null, intents: [], notices: {}, buttons, readerPanels,
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
  server.handle(turnStatusRpc, async () => { await loaded; return current?.turns.status() ?? { connected: false }; });
  server.handle(turnBehaviorRpc, input => operate(input, ({ turns }) => turns.behavior(input.hostId, input.agentId, input.behavior)));
  server.handle(ackRpc, input => operate(input, async ({ hub }) => ({ acknowledged: await hub.ack(input.ids) })));
  server.handle(openRpc, (input, context) => operate(input, async session => { attach(session, context); await session.hub.open(input.documentId ? `id:${input.documentId}` : input.path!, input.workspaceId); return { queued: true }; }));
  server.handle(openNoticeRpc, input => operate(input, async ({ hub }) => { await hub.openNotice(input.documentId, input.workspaceId); return { queued: true }; }));
  server.handle(pinRpc, input => operate(input, async ({ hub }) => { await hub.pin(input.documentId ? `id:${input.documentId}` : input.path!, input.pinned); return { pinned: input.pinned }; }));
  server.handle(themeRpc, input => operate(input, ({ hub }) => hub.theme(input.clientId, input.theme)));
  server.handle(folioViewRpc, input => operate(input, ({ hub }) => hub.folioView(input.workspaceId)));

  registerChat(server, async input => {
    await loaded;
    const session = current;
    if (!session) throw new Error("Tether connection settings are unavailable.");
    const run = createTetherRunner({ binary: () => resolveTether(session.connection.tetherPath), profile: () => session.connection.profile, signal: session.controller.signal, pool });
    if (input.generation !== session.connection.generation) throw new Error("Tether connection changed. Reload Paseo before editing annotations.");
    const result = await runChat(run, input);
    if (current !== session) throw new Error("Tether connection changed; refresh before retrying.");
    return result;
  });

  const turnHooks = ["agent.turn_started", "agent.turn_ended", "agent.permission_requested", "agent.permission_resolved", "agent.archived"] as const;
  const stopTurnHooks = turnHooks.map(name => server.on(name, event => current?.turns.wake(event.agent.id)));
  server.before("agent.session_open", ({ request }) => ({ ...request, env: { ...request.env,
    ...(request.workspaceId ? { TETHER_PASEO_WORKSPACE_ID: request.workspaceId } : {}),
    ...(current ? { TETHER_PROFILE: request.env.TETHER_PROFILE ?? current.connection.profile,
      ...(current.sharedConnection ? { TETHER_CONNECTION: request.env.TETHER_CONNECTION ?? current.sharedConnection } : {}),
      ...(current.turns.status().hostId ? { TETHER_PASEO_HOST_ID: current.turns.status().hostId! } : {}) } : {}),
  } }));
  return async () => { disposed = true; const stopping = clear(); initialized(); unsubscribe(); for (const stop of stopTurnHooks) stop(); await stopping; };
}
