import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { openRpc, openNoticeRpc, type Notice } from "../shared/contracts";
import { ThemeMark } from "./theme-mark";
import { FOLIO_PANEL } from "./pump";
import { getState, subscribeState } from "./state";
import { restoreTabs, type Restore } from "./tab-restore";

/**
 * One Tether button per workspace header. It reveals that workspace's Folio,
 * and when an agent announces a document for the workspace it shows the
 * document's name and opens it. After a workspace move it shows how many
 * browser tabs are queued and opens them. Nothing opens until the user presses it.
 */
export function startHeaderButtons(client: PluginClientContext): () => void {
  let stopped = false;
  let release: (() => void) | undefined;
  const buttons = new Map<string, PluginButtonRegistration>();
  const shown = new Map<string, string>();

  const present = (workspaceId: string, notice: Notice | undefined, restore: Restore | undefined, visible: boolean, generation: string | undefined) => ({
    title: restore ? `Open ${restore.urls.length} queued browser tab${restore.urls.length === 1 ? "" : "s"} from before the move` : notice ? `Open ${notice.name} in Tether` : "Tether Folio",
    icon: ThemeMark,
    label: restore ? `${restore.urls.length} tab${restore.urls.length === 1 ? "" : "s"} queued` : notice?.name,
    visible,
    behavior: {
      kind: "action" as const,
      onPress: () => {
        if (restore) {
          if (!restoreTabs(workspaceId)) client.openPanel(FOLIO_PANEL, { workspaceId, location: "explorer" });
          return;
        }
        if (!notice) { client.openPanel(FOLIO_PANEL, { workspaceId, location: "explorer" }); return; }
        if (notice.sharedReader) {
          client.openPanel(FOLIO_PANEL, { workspaceId, location: "explorer" });
          void client.rpc(openNoticeRpc, { documentId: notice.sharedReader.documentId, workspaceId, generation }).catch(() => {});
        } else void client.rpc(openRpc, { ...(notice.documentId ? { documentId: notice.documentId } : { path: notice.path }), workspaceId, generation }).catch(() => {});
      },
    },
  });

  const render = (workspaceId: string) => {
    const { notices, restores, buttons: enabled, connection } = getState();
    const notice = notices[workspaceId];
    const restore = restores[workspaceId];
    const key = `${connection?.generation}:${enabled}:${notice?.sharedReader?.url ?? notice?.documentId ?? notice?.path ?? ""}:${notice?.name ?? ""}:${restore?.urls.length ?? 0}`;
    if (shown.get(workspaceId) === key) return;
    shown.set(workspaceId, key);
    const button = present(workspaceId, notice, restore, enabled, connection?.generation);
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
