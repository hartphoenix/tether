export type DiagramPalette = { dark: boolean; background: string; surface: string; surfaceLow: string; ink: string; outline: string; line: string };

export function diagramPalette(colors: Record<string, string>, dark: boolean): DiagramPalette {
  return { dark, background: colors.background, surface: colors.surface, surfaceLow: colors['surface-low'], ink: colors['on-surface'], outline: colors.outline, line: colors['on-surface-variant'] };
}

/** Fixed keys and hex colors only; no caller-provided Mermaid configuration or CSS. */
export function parseDiagramPalette(value: unknown): DiagramPalette {
  const input = value as DiagramPalette;
  if (!input || typeof input.dark !== 'boolean') throw new Error('Invalid diagram palette');
  const colors = ['background', 'surface', 'surfaceLow', 'ink', 'outline', 'line'] as const;
  for (const key of colors) if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) throw new Error('Invalid diagram palette');
  return { dark: input.dark, background: input.background, surface: input.surface, surfaceLow: input.surfaceLow, ink: input.ink, outline: input.outline, line: input.line };
}

export function diagramThemeOptions(palette: DiagramPalette, fontFamily: string) {
  const { background, surface, ink, outline } = palette;
  return {
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", suppressErrorRendering: true,
    themeVariables: {
      darkMode: palette.dark, fontFamily,
      background, primaryColor: surface, primaryTextColor: ink, primaryBorderColor: outline,
      secondaryColor: palette.surfaceLow, secondaryTextColor: ink, secondaryBorderColor: outline,
      tertiaryColor: background, tertiaryTextColor: ink, tertiaryBorderColor: outline,
      lineColor: palette.line, textColor: ink,
      mainBkg: surface, nodeBorder: outline, clusterBkg: palette.surfaceLow, clusterBorder: outline,
      edgeLabelBackground: background, titleColor: ink,
      actorBkg: surface, actorTextColor: ink, actorBorder: outline, actorLineColor: outline,
      signalColor: ink, signalTextColor: ink, labelBoxBkgColor: surface, labelBoxBorderColor: outline, labelTextColor: ink,
      noteBkgColor: palette.surfaceLow, noteTextColor: ink, noteBorderColor: outline,
      activationBkgColor: surface, activationBorderColor: outline,
    },
  } as const;
}
