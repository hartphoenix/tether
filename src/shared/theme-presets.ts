import type { ThemeDesign } from './themes';

// Finalized Tether presets. Keep independent values for each theme.
export const themePresets = {
  "tether": {
    "base": "tether",
    "colors": {
      "background": "#f5f3ee",
      "on-background": "#343a40",
      "surface": "#eeece6",
      "surface-low": "#e9e7e0",
      "on-surface": "#343a40",
      "on-surface-variant": "#62676b",
      "outline": "#818580",
      "primary": "#486575",
      "secondary": "#dce4e5",
      "on-secondary": "#304854",
      "inverse": "#343a40",
      "on-inverse": "#f5f3ee",
      "inline-code": "#506878",
      "error": "#a04741",
      "hover": "#e1e5e3",
      "selected": "#cbdadd",
      "inline-area": "#e7ebe9",
      "annotation": "#f1be5c"
    },
    "fonts": {
      "heading": {
        "family": "Source Serif 4",
        "fallback": "serif"
      },
      "body": {
        "family": "Source Serif 4",
        "fallback": "serif"
      },
      "code": {
        "family": "DM Mono",
        "fallback": "monospace"
      }
    },
    "metrics": {
      "headingSize": 40,
      "headingWeight": 500,
      "headingSpacing": -0.014,
      "bodySize": 20,
      "bodyWeight": 300,
      "bodySpacing": 0,
      "lineHeight": 1.65,
      "paragraphGap": 0.75,
      "lineWidth": 64,
      "codeSize": 15,
      "codeWeight": 400,
      "codeLineHeight": 1.6
    }
  },
  "tether-dark": {
    "base": "tether-dark",
    "colors": {
      "background": "#20252b",
      "on-background": "#c9cdd1",
      "surface": "#292f36",
      "surface-low": "#242a31",
      "on-surface": "#c9cdd1",
      "on-surface-variant": "#a0a8b1",
      "outline": "#717c88",
      "primary": "#a3bccb",
      "secondary": "#35444f",
      "on-secondary": "#d5dfe5",
      "inverse": "#d4d8dc",
      "on-inverse": "#252b32",
      "inline-code": "#b6c5d0",
      "error": "#dfa5a0",
      "hover": "#333e48",
      "selected": "#405462",
      "inline-area": "#2c353f",
      "annotation": "#ffbe3e"
    },
    "fonts": {
      "heading": {
        "family": "Source Serif 4",
        "fallback": "serif"
      },
      "body": {
        "family": "Source Serif 4",
        "fallback": "serif"
      },
      "code": {
        "family": "DM Mono",
        "fallback": "monospace"
      }
    },
    "metrics": {
      "headingSize": 40,
      "headingWeight": 500,
      "headingSpacing": -0.014,
      "bodySize": 20,
      "bodyWeight": 300,
      "bodySpacing": 0,
      "lineHeight": 1.65,
      "paragraphGap": 0.75,
      "lineWidth": 64,
      "codeSize": 15,
      "codeWeight": 400,
      "codeLineHeight": 1.6
    }
  },
  "light-treason": {
    "base": "tether",
    "colors": {
      "background": "#f6f5f1",
      "on-background": "#29323d",
      "surface": "#eeefed",
      "surface-low": "#e8ebe9",
      "on-surface": "#29323d",
      "on-surface-variant": "#a2adb8",
      "outline": "#75818d",
      "primary": "#46667d",
      "secondary": "#d8e2e9",
      "on-secondary": "#293e50",
      "inverse": "#29323d",
      "on-inverse": "#f6f5f1",
      "inline-code": "#59657d",
      "error": "#9c4141",
      "hover": "#dbe1e1",
      "selected": "#cfdae3",
      "inline-area": "#e6e9ed",
      "annotation": "#f1be5c"
    },
    "fonts": {
      "heading": {
        "family": "Hanken Grotesk",
        "fallback": "sans-serif"
      },
      "body": {
        "family": "Hanken Grotesk",
        "fallback": "sans-serif"
      },
      "code": {
        "family": "DM Mono",
        "fallback": "monospace"
      }
    },
    "metrics": {
      "headingSize": 38,
      "headingWeight": 460,
      "headingSpacing": -0.012,
      "bodySize": 19,
      "bodyWeight": 300,
      "bodySpacing": 0.01,
      "lineHeight": 1.65,
      "paragraphGap": 0.65,
      "lineWidth": 68,
      "codeSize": 15.5,
      "codeWeight": 300,
      "codeLineHeight": 1.6
    }
  },
  "dark-academia": {
    "base": "tether-dark",
    "colors": {
      "background": "#1d1e20",
      "on-background": "#dce1e7",
      "surface": "#2a2d30",
      "surface-low": "#202730",
      "on-surface": "#dce1e7",
      "on-surface-variant": "#74976e",
      "outline": "#8290a0",
      "primary": "#6a8c63",
      "secondary": "#364758",
      "on-secondary": "#e0e8f0",
      "inverse": "#dce1e7",
      "on-inverse": "#242c36",
      "inline-code": "#b5bdcd",
      "error": "#e3a9a9",
      "hover": "#313e2f",
      "selected": "#41643b",
      "inline-area": "#313438",
      "annotation": "#ffbe3e"
    },
    "fonts": {
      "heading": {
        "family": "Alegreya",
        "fallback": "serif"
      },
      "body": {
        "family": "Source Serif 4",
        "fallback": "serif"
      },
      "code": {
        "family": "DM Mono",
        "fallback": "monospace"
      }
    },
    "metrics": {
      "headingSize": 42,
      "headingWeight": 630,
      "headingSpacing": 0.05,
      "bodySize": 20,
      "bodyWeight": 300,
      "bodySpacing": 0,
      "lineHeight": 1.65,
      "paragraphGap": 0.65,
      "lineWidth": 68,
      "codeSize": 16,
      "codeWeight": 400,
      "codeLineHeight": 1.6
    }
  }
} satisfies Record<string, ThemeDesign>;
