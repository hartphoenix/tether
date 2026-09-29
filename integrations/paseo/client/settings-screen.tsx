import { useThemeReport } from "./use-theme-report";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text } from "react-native";
import { tetherSettings } from "../shared/contracts";
import { useTetherState } from "./state";

type Ready = Extract<SettingsState<typeof tetherSettings.schema>, { status: "ready" }>;

function Connection({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const status = useTetherState(state => state.status);
  const text = status.connected ? "Connected" : status.error ? `Not connected: ${status.error}` : "Connecting…";
  return (
    <SettingsRow label="Tether" hint={text}>
      <Text style={{ color: status.connected ? theme.colors.foreground : theme.colors.foregroundMuted }}>{status.connected ? "●" : "○"}</Text>
    </SettingsRow>
  );
}

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  // Text fields save together, against the revision they were drafted from.
  const [draft, setDraft] = useState(() => ({ tetherPath: settings.values.tetherPath, profile: settings.values.profile, revision: settings.revision }));
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  return (
    <SettingsSection title="Tether">
      <SettingsCard>
        <Connection theme={theme} />
        <SettingsSwitch
          label="Header button"
          hint="Opens Folio and shows documents added by agents. Also keeps inherited themes in sync when Folio and these settings are closed."
          value={settings.values.buttons}
          disabled={settings.saving}
          onValueChange={buttons => { void settings.save({ ...settings.values, buttons }, settings.revision); }}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="Tether command"
          hint="Leave empty to find tether on PATH or in ~/.local/bin."
          initialValue={draft.tetherPath}
          placeholder="/Users/you/.local/bin/tether"
          disabled={settings.saving}
          onChangeText={tetherPath => setDraft(current => ({ ...current, tetherPath }))}
        />
        <SettingsInput
          label="Profile"
          hint="The Tether profile to use. The default is preview."
          initialValue={draft.profile}
          disabled={settings.saving}
          error={settings.saveError}
          onChangeText={profile => setDraft(current => ({ ...current, profile }))}
        />
        <SettingsAction
          label="Connection settings"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={() => { void settings.save({ ...settings.values, tetherPath: draft.tetherPath, profile: draft.profile }, draft.revision); }}
        />
      </SettingsCard>
      <Text style={muted}>Changes take effect on the next request to Tether.</Text>
    </SettingsSection>
  );
}

export function SettingsScreen(props: PluginSurfaceProps) {
  useThemeReport(props);
  const { theme } = props;
  const settings = useSettings(tetherSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Tether">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  }
  return <Controls settings={settings} theme={theme} />;
}
