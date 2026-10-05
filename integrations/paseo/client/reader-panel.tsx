import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openRpc, type Connection } from "../shared/contracts";
import { mountReader, readerDocument, relaunch, savedSession, saveSession, takeLaunch, type ReaderDocument } from "./reader-panels";
import { useTetherState } from "./state";
import { themedLaunch } from "./theme-sync";
import { useThemeReport } from "./use-theme-report";
import { isDesktop } from "./web";
import { mountFolioWebview, type FolioViewState } from "./web-folio";

// Launch tickets last 30 seconds; leave room for the exchange.
const HANDOFF_MS = 20_000;

/** Marks the launch so the reader opens links through Tether's queue; a panel can't open tabs itself. */
function panelLaunch(value: string): string {
  const url = new URL(themedLaunch(value));
  url.searchParams.set("surface", "panel");
  return url.href;
}

type ViewProps = PluginWorkspacePanelProps & { panelId: string; document: ReaderDocument; connection: Connection; cacheKey: string };

function ReaderView({ panelId, document, connection, cacheKey, ...props }: ViewProps) {
  const open = useRpc(openRpc);
  const themeReady = useThemeReport(props);
  const container = useRef<View>(null);
  const handoff = useRef<string | undefined>(undefined);
  const [state, setState] = useState<FolioViewState>("loading");
  const [attempt, setAttempt] = useState(0);
  const { workspaceId, theme } = props;
  const openBrowser = props.navigation?.openBrowser;
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted, padding: 12 }), [theme]);
  const request = () => open({ path: document.path, workspaceId, generation: connection.generation });

  useEffect(() => {
    let disposed = false, cleanup = () => {};
    let launch = handoff.current ?? takeLaunch(panelId, workspaceId);
    const handedAt = Date.now();
    handoff.current = undefined;
    const release = mountReader(panelId, workspaceId, url => { handoff.current = url; setAttempt(value => value + 1); });
    setState("loading");
    const timer = setTimeout(() => { disposed = true; setState("failed"); }, 15000);
    void themeReady.current.then(() => {
      clearTimeout(timer);
      if (disposed) return;
      cleanup = mountFolioWebview(container.current, {
        kind: "reader",
        cacheKey,
        saved: savedSession(cacheKey),
        onSession: url => saveSession(cacheKey, url),
        // A link to a heading replaces the session; otherwise the cached session keeps its scroll position.
        fresh: Boolean(launch && new URL(launch).hash),
        launch: async () => {
          await themeReady.current;
          const handed = launch && Date.now() - handedAt < HANDOFF_MS ? launch : undefined;
          launch = undefined;
          const url = handed ?? await relaunch(panelId, workspaceId, request);
          return { url: panelLaunch(url), expiresAt: Date.now() + HANDOFF_MS };
        },
        onState: setState,
      });
    }, () => { clearTimeout(timer); if (!disposed) setState("failed"); });
    return () => { disposed = true; clearTimeout(timer); release(); cleanup(); };
  }, [cacheKey, panelId, workspaceId, attempt, connection.generation]);

  const openInBrowser = () => {
    if (!openBrowser) return;
    void relaunch(panelId, workspaceId, request).then(url => openBrowser({ url: themedLaunch(url), workspaceId }), () => {});
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {state === "loading" ? <Text style={muted}>Opening {document.name}…</Text> : null}
      <View ref={container} style={{ flex: 1, display: state === "failed" ? "none" : "flex" }} />
      {state === "failed" ? (
        <View style={{ padding: 12, gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>{document.name} couldn't be opened here.</Text>
          <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)}>
            <Text style={{ color: theme.colors.accent }}>Retry</Text>
          </Pressable>
          {openBrowser ? (
            <Pressable accessibilityRole="button" onPress={openInBrowser}>
              <Text style={{ color: theme.colors.accent }}>Open in a browser tab</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One component per document panel; the panel ID names the document. */
export function readerPanelComponent(panelId: string) {
  return function TetherReaderPanel(props: PluginWorkspacePanelProps) {
    const connection = useTetherState(state => state.connection);
    const document = readerDocument(panelId);
    const muted = { color: props.theme.colors.foregroundMuted, padding: 12 };
    if (!document) return <Text style={muted}>This reader is no longer available.</Text>;
    if (!isDesktop()) return <Text style={muted}>Reader panels need the Paseo desktop app.</Text>;
    if (!connection) return <Text style={muted}>Connecting to Tether…</Text>;
    const cacheKey = JSON.stringify([props.host.id, connection.tetherPath, connection.profile, props.workspaceId, panelId]);
    return <ReaderView key={`${cacheKey}:${connection.generation}`} panelId={panelId} document={document} connection={connection} cacheKey={cacheKey} {...props} />;
  };
}
