import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { openRpc, type Notice } from "../shared/contracts";
import { ThemeMark } from "./theme-mark";
import { FOLIO_PANEL } from "./pump";
import { getState, subscribeState } from "./state";

/**
 * One Tether button per workspace header. It reveals that workspace's Folio,
 * and when an agent announces a document for the workspace it shows the
 * document's name and opens it. Nothing opens until the user presses it.
 */
export function startHeaderButtons(client: PluginClientContext): () => void {
  let stopped = false;
  let release: (() => void) | undefined;
  const buttons = new Map<string, PluginButtonRegistration>();
  const shown = new Map<string, string>();

  const present = (workspaceId: string, notice: Notice | undefined, visible: boolean) => ({
    title: notice ? `Open ${notice.name} in Tether` : "Tether Folio",
    icon: ThemeMark,
    label: notice?.name,
    visible,
    behavior: {
      kind: "action" as const,
      onPress: () => {
        if (!notice) { client.openPanel(FOLIO_PANEL, { workspaceId, location: "explorer" }); return; }
        void client.rpc(openRpc, { path: notice.path, workspaceId });
      },
    },
  });

  const render = (workspaceId: string) => {
    const { notices, buttons: enabled } = getState();
    const notice = notices[workspaceId];
    const key = `${enabled}:${notice?.path ?? ""}:${notice?.name ?? ""}`;
    if (shown.get(workspaceId) === key) return;
    shown.set(workspaceId, key);
    const button = present(workspaceId, notice, enabled);
    const existing = buttons.get(workspaceId);
    if (existing) existing.update(button);
    else buttons.set(workspaceId, client.addHeaderButton({ id: "tether", workspaceId, button }));
  };
  const drop = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
    shown.delete(workspaceId);
  };

  const unsubscribe = subscribeState(() => { for (const workspaceId of buttons.keys()) render(workspaceId); });
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) { void subscription.release(); return; }
      release = () => { void subscription.release(); };
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map(workspace => workspace.id));
          for (const workspaceId of [...buttons.keys()]) if (!current.has(workspaceId)) drop(workspaceId);
          for (const workspaceId of current) render(workspaceId);
        },
        update: message => {
          if (message.type !== "workspace_update") return;
          if (message.payload.kind === "remove") drop(message.payload.id);
          else render(message.payload.workspace.id);
        },
      });
    })
    .catch(() => {});

  return () => {
    stopped = true;
    release?.();
    unsubscribe();
    for (const workspaceId of [...buttons.keys()]) drop(workspaceId);
  };
}
