import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { openRpc, pinRpc, type FolioEntry } from "../shared/contracts";
import { setState, useTetherState, type FolioScope } from "./state";

function within(path: string, root: string): boolean {
  return path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function place(entry: FolioEntry, root: string | null): string {
  if (root && within(entry.directory + "/", root)) return entry.directory.slice(root.length).replace(/^\//, "") || ".";
  return entry.directory.replace(/^\/Users\/[^/]+/, "~");
}

export function FolioList({ theme, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const generation = useTetherState(state => state.connection?.generation);
  const folio = useTetherState(state => state.folio);
  const status = useTetherState(state => state.status);
  const query = useTetherState(state => state.query);
  const scope = useTetherState(state => state.scope);
  const projectRoot = useWorkspace(workspaceId, workspace => workspace.projectRootPath);
  const open = useRpc(openRpc);
  const pin = useRpc(pinRpc);
  const toast = useToast();
  const openBrowser = navigation?.openBrowser;

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (folio ?? []).filter(entry =>
      (scope === "all" || !projectRoot || within(entry.path, projectRoot))
      && (!needle || entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle)));
  }, [folio, query, scope, projectRoot]);

  const styles = useMemo(() => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    toolbar: { padding: layout.compact ? 8 : 10, gap: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
    input: { color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13 * 9 / 11 },
    scopes: { flexDirection: "row" as const, gap: 6 },
    scope: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border },
    scopeActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    scopeText: { color: theme.colors.foregroundMuted, fontSize: 12 * 9 / 11 },
    scopeTextActive: { color: theme.colors.accentForeground, fontSize: 12 * 9 / 11 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingHorizontal: layout.compact ? 8 : 10, paddingVertical: 7 },
    body: { flex: 1, minWidth: 0 },
    name: { color: theme.colors.foreground, fontSize: 13 * 9 / 11 },
    missing: { color: theme.colors.foregroundMuted, fontSize: 13 * 9 / 11, textDecorationLine: "line-through" as const },
    detail: { color: theme.colors.foregroundMuted, fontSize: 11 * 9 / 11 },
    badge: { minWidth: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: theme.colors.accent, alignItems: "center" as const },
    badgeText: { color: theme.colors.accentForeground, fontSize: 11 * 9 / 11 },
    note: { color: theme.colors.foregroundMuted, fontSize: 12 * 9 / 11, padding: 12 },
  }), [theme, layout.compact]);

  const launch = (entry: FolioEntry) => {
    if (entry.missing) return;
    void open({ path: entry.path, workspaceId, generation }).catch(cause => toast.show(`Couldn't open ${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`, { variant: "error" }));
  };
  const togglePin = (entry: FolioEntry) => {
    void pin({ path: entry.path, pinned: !entry.pinned, generation }).catch(cause => toast.show(cause instanceof Error ? cause.message : String(cause), { variant: "error" }));
  };
  const scopeButton = (value: FolioScope, label: string) => (
    <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: scope === value }} onPress={() => setState({ scope: value })} style={[styles.scope, scope === value && styles.scopeActive]}>
      <Text style={scope === value ? styles.scopeTextActive : styles.scopeText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={text => setState({ query: text })}
          placeholder="Filter documents"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Filter Folio"
          style={styles.input}
        />
        <View style={styles.scopes}>
          {scopeButton("project", "This project")}
          {scopeButton("all", "All")}
        </View>
      </View>
      {!openBrowser ? <Text style={styles.note}>Reader tabs open only in Paseo desktop.</Text> : null}
      {status.error ? <Text style={styles.note}>Tether is unavailable: {status.error}</Text> : null}
      <FlatList
        data={entries}
        keyExtractor={entry => entry.path}
        ListEmptyComponent={<Text style={styles.note}>{folio === null ? "Connecting to Tether…" : "No documents here yet."}</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.name}`}
            disabled={item.missing || !openBrowser}
            onPress={() => launch(item)}
            style={styles.row}
          >
            <View style={styles.body}>
              <Text numberOfLines={1} style={item.missing ? styles.missing : styles.name}>{item.name}</Text>
              <Text numberOfLines={1} style={styles.detail}>{item.missing ? "File not found" : place(item, projectRoot)}</Text>
            </View>
            {item.attentionCount > 0 ? (
              <View style={styles.badge} accessibilityLabel={`${item.attentionCount} open threads`}>
                <Text style={styles.badgeText}>{item.attentionCount}</Text>
              </View>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel={item.pinned ? `Unpin ${item.name}` : `Pin ${item.name}`} hitSlop={6} onPress={() => togglePin(item)}>
              <Icon name={item.pinned ? "Pin" : "PinOff"} size={14} color={item.pinned ? theme.colors.accent : theme.colors.foregroundMuted} />
            </Pressable>
          </Pressable>
        )}
      />
    </View>
  );
}
