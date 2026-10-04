import { useThemeReport } from "./use-theme-report";
import { themedLaunch } from "./theme-sync";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ackRpc, folioViewRpc, tetherSettings, type TetherSettings } from "../shared/contracts";
import { FolioList } from "./folio-list";
import { lendOpener, useTetherState } from "./state";
import { lendUrlOpener } from "./tab-restore";
import { isDesktop } from "./web";
import { folioViewKey, mountFolioWebview, type FolioViewState } from "./web-folio";

function EmbeddedFolio({ settings, cacheKey, generation, ...props }: PluginWorkspacePanelProps & { settings: TetherSettings; cacheKey: string; generation: string }) {
  const launch = useRpc(folioViewRpc);
  const [attempt, setAttempt] = useState(0);
  const themeReady = useThemeReport(props);
  const container = useRef<View>(null);
  const [state, setState] = useState<FolioViewState>("loading");
  const { workspaceId, theme } = props;
  const { tetherPath, profile } = settings;
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    setState("loading");
    const timer = setTimeout(() => { disposed = true; setState("failed"); }, 15000);
    void themeReady.current.then(() => {
      clearTimeout(timer);
      if (disposed) return;
      cleanup = mountFolioWebview(container.current, {
        cacheKey,
        launch: async () => {
          await themeReady.current;
          const result = await launch({ workspaceId, tetherPath, profile, generation });
          return { ...result, url: themedLaunch(result.url) };
        },
        onState: setState,
      });
    }, () => { clearTimeout(timer); if (!disposed) setState("failed"); });
    return () => { disposed = true; clearTimeout(timer); cleanup(); };
  }, [cacheKey, workspaceId, tetherPath, profile, launch, attempt, generation]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {state === "loading" ? <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>Loading Folio…</Text> : null}
      <View ref={container} style={{ flex: 1, display: state === "failed" ? "none" : "flex" }} />
      {state === "failed" ? <>
        <View style={{ padding: 10, gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>Full Folio is unavailable. Showing the document list.</Text>
          <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)}>
            <Text style={{ color: theme.colors.accent }}>Retry full Folio</Text>
          </Pressable>
        </View>
        <FolioList {...props} />
      </> : null}
    </View>
  );
}

/** The executor remains mounted through web loading, recovery, and native fallback. */
export function FolioPanel(props: PluginWorkspacePanelProps) {
  const connection = useTetherState(state => state.connection);
  const ack = useRpc(ackRpc);
  const settings = useSettings(tetherSettings);
  const openBrowser = props.navigation?.openBrowser;
  useEffect(() => {
    if (!openBrowser) return;
    return lendOpener(
      intent => openBrowser({ url: themedLaunch(intent.url), workspaceId: intent.workspaceId }),
      intent => { void ack({ ids: [intent.id], generation: intent.generation }).catch(() => {}); },
    );
  }, [openBrowser, ack]);
  useEffect(() => openBrowser ? lendUrlOpener((url, workspaceId) => openBrowser({ url, workspaceId })) : undefined, [openBrowser]);

  if (!connection) return <FolioList {...props} />;
  if (!isDesktop() || !openBrowser || (settings.status !== "ready" && settings.status !== "loading")) return <FolioList {...props} />;
  if (settings.status === "loading") return <Text style={{ color: props.theme.colors.foregroundMuted, padding: 12 }}>Loading Folio…</Text>;
  if (connection.tetherPath !== settings.values.tetherPath || connection.profile !== settings.values.profile) return <Text style={{ color: props.theme.colors.foregroundMuted, padding: 12 }}>Connecting to Tether…</Text>;
  const key = folioViewKey(props.host.id, settings.values.tetherPath, settings.values.profile, props.workspaceId);
  return <EmbeddedFolio key={`${key}:${connection.generation}`} cacheKey={key} generation={connection.generation} settings={settings.values} {...props} />;
}
