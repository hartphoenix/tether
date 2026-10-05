import { clearThemeReports } from "./client/theme-sync";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FolioPanel } from "./client/folio-panel";
import { startHeaderButtons } from "./client/header-buttons";
import { FOLIO_PANEL, startPump } from "./client/pump";
import { SettingsScreen } from "./client/settings-screen";
import { startTabRestore } from "./client/tab-restore";
import { tetherThemes } from "./client/themes";
import { disposeFolioViews } from "./client/web-folio";

export default function contribute(client: PluginClientContext) {
  const removeThemes = tetherThemes.map(theme => client.addTheme(theme));
  client.addWorkspacePanel({ id: FOLIO_PANEL, title: "Folio", icon: "BookOpen", context: "workspace", locations: ["explorer"], Component: FolioPanel });
  client.addSettingsScreen({ id: "tether", title: "Settings", icon: "BookOpen", Component: SettingsScreen });
  const stopPump = startPump(client);
  const stopButtons = startHeaderButtons(client);
  const stopRestore = startTabRestore(client);
  return () => {
    for (const removeTheme of removeThemes) removeTheme();
    disposeFolioViews();
    clearThemeReports();
    stopRestore();
    stopButtons();
    stopPump();
  };
}
