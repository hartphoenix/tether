import type { PluginButtonIconProps } from '@getpaseo/plugin/client';
import { TetherMark } from './mark';
import { useThemeReport } from './use-theme-report';

export function ThemeMark(props: PluginButtonIconProps) {
  useThemeReport(props);
  return <TetherMark size={props.size} />;
}
