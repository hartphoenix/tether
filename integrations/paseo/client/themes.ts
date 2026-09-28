import type { PluginThemeContribution } from "@getpaseo/plugin";

// Keep Tether dropdown order and map src/shared/theme-presets.ts into Paseo surface roles.
// Palettes stay inside the standalone plugin package.
export const tetherThemes = [
  {
    "id": "tether",
    "name": "Tether Light",
    "appearance": "light",
    "colors": {
      "background": "#f5f3ee",
      "foreground": "#343a40",
      "raised": "#eeece6",
      "control": "#e7ebe9",
      "border": "#e1e5e3",
      "accent": "#486575",
      "mutedForeground": "#62676b",
      "ring": "#818580"
    }
  },
  {
    "id": "tether-dark",
    "name": "Tether Dark",
    "appearance": "dark",
    "colors": {
      "background": "#20252b",
      "foreground": "#c9cdd1",
      "raised": "#292f36",
      "control": "#2c353f",
      "border": "#333e48",
      "accent": "#a3bccb",
      "mutedForeground": "#a0a8b1",
      "ring": "#717c88"
    }
  },
  {
    "id": "light-treason",
    "name": "Light Treason",
    "appearance": "light",
    "colors": {
      "background": "#f6f5f1",
      "foreground": "#29323d",
      "raised": "#eeefed",
      "control": "#e6e9ed",
      "border": "#dbe1e1",
      "accent": "#46667d",
      // Paseo uses these for navigation labels and subdued header text.
      "mutedForeground": "#556371",
      "ring": "#596571"
    }
  },
  {
    "id": "dark-academia",
    "name": "Dark Academia",
    "appearance": "dark",
    "colors": {
      "background": "#1d1e20",
      "foreground": "#dce1e7",
      "raised": "#2a2d30",
      "control": "#313438",
      "border": "#313e2f",
      "accent": "#6a8c63",
      "mutedForeground": "#74976e",
      "ring": "#8290a0"
    }
  }
] satisfies PluginThemeContribution[];
