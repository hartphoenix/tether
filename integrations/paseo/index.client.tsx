import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FolioPanel } from "./client/folio-panel";
import { startHeaderButtons } from "./client/header-buttons";
import { FOLIO_PANEL, startPump } from "./client/pump";
import { SettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: FOLIO_PANEL, title: "Folio", icon: "BookOpen", context: "workspace", locations: ["explorer"], Component: FolioPanel });
  client.addSettingsScreen({ id: "tether", title: "Tether", icon: "BookOpen", Component: SettingsScreen });
  const stopPump = startPump(client);
  const stopButtons = startHeaderButtons(client);
  return () => {
    stopButtons();
    stopPump();
  };
}
