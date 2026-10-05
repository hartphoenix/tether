import { clearThemeReports } from "./client/theme-sync";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FolioPanel } from "./client/folio-panel";
import { startHeaderButtons } from "./client/header-buttons";
import { FOLIO_PANEL, startPump } from "./client/pump";
import { readerPanelComponent } from "./client/reader-panel";
import { startReaderPanels } from "./client/reader-panels";
import { SettingsScreen } from "./client/settings-screen";
import { startTabRestore } from "./client/tab-restore";
import { tetherThemes } from "./client/themes";
import { disposeFolioViews } from "./client/web-folio";

export default function contribute(client: PluginClientContext) {
  const removeThemes = tetherThemes.map(theme => client.addTheme(theme));
  client.addWorkspacePanel({ id: FOLIO_PANEL, title: "Folio", icon: "BookOpen", context: "workspace", locations: ["explorer"], Component: FolioPanel });
  client.addSettingsScreen({ id: "tether", title: "Settings", icon: "BookOpen", Component: SettingsScreen });
  // Before the pump, so restored reader tabs resolve and the first batch finds the panel opener.
  const stopReaders = startReaderPanels(client, readerPanelComponent);
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
    stopReaders();
  };
}
