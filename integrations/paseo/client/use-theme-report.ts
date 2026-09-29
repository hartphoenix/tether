import { useEffect, useRef } from 'react';
import { useRpc, useSettings, type PluginHostProps } from '@getpaseo/plugin/client';
import { themeRpc, tetherSettings } from '../shared/contracts';
import { matchingTheme, reportTheme, themeClientId } from './theme-sync';
import { useTetherState } from './state';

/** Report only while a host component supplying live theme props is mounted. */
export function useThemeReport(props: PluginHostProps) {
  const settings = useSettings(tetherSettings);
  const send = useRpc(themeRpc);
  const generation = useTetherState(state => state.connection?.generation);
  const serverPath = useTetherState(state => state.connection?.tetherPath);
  const serverProfile = useTetherState(state => state.connection?.profile);
  const connected = useTetherState(state => state.status.connected);
  const theme = matchingTheme(props.theme);
  const path = settings.status === 'ready' ? settings.values.tetherPath : undefined;
  const profile = settings.status === 'ready' ? settings.values.profile : undefined;
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!generation || path === undefined || profile === undefined || serverPath !== path || serverProfile !== profile) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const clientId = themeClientId();
    const connection = JSON.stringify([clientId, props.host.id, path, profile, generation]);
    const attempt = () => {
      const promise = reportTheme(connection, theme, () => send({ clientId, theme, tetherPath: path, profile, generation }), true);
      // Folio can load on older daemons without theme reporting. Keep the original
      // rejection below for retries, but do not make optional sync a launch failure.
      ready.current = promise.catch(() => undefined);
      void promise.then(() => {
        // A daemon can restart without a failed UI request. Reassert while mounted.
        if (!stopped) timer = setTimeout(attempt, 15000);
        delay = 500;
      }, () => {
        if (!stopped) timer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, 15000);
      });
    };
    attempt();
    return () => { stopped = true; clearTimeout(timer); };
  }, [theme, props.host.id, path, profile, send, connected, generation, serverPath, serverProfile]);
  return ready;
}
