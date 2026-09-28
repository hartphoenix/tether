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
  },
  // Paseo palettes: source surfaces, readable accent text, and Tether reading typography.
  "paseo-light": {
    "base": "tether",
    "colors": {
      "background": "#ffffff",
      "on-background": "#1a1a1e",
      "surface": "#fafafa",
      "surface-low": "#f4f4f5",
      "on-surface": "#1a1a1e",
      "on-surface-variant": "#616169",
      "outline": "#8c8c94",
      "primary": "#1f6f47",
      "secondary": "#e6eeea",
      "on-secondary": "#1a1a1e",
      "inverse": "#1a1a1e",
      "on-inverse": "#ffffff",
      "inline-code": "#1f5e3f",
      "error": "#a93e36",
      "hover": "#f4f4f5",
      "selected": "#d4e1db",
      "inline-area": "#fafafa",
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
  "paseo-dark": {
    "base": "tether-dark",
    "colors": {
      "background": "#181b1a",
      "on-background": "#fafafa",
      "surface": "#1e2120",
      "surface-low": "#272a29",
      "on-surface": "#fafafa",
      "on-surface-variant": "#b1b4b3",
      "outline": "#717574",
      "primary": "#7ccba0",
      "secondary": "#2b3932",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#181b1a",
      "inline-code": "#9cd7b7",
      "error": "#e1a59f",
      "hover": "#272a29",
      "selected": "#384a41",
      "inline-area": "#1e2120",
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
  "paseo-zinc": {
    "base": "tether-dark",
    "colors": {
      "background": "#18181b",
      "on-background": "#fafafa",
      "surface": "#1f1f22",
      "surface-low": "#27272a",
      "on-surface": "#fafafa",
      "on-surface-variant": "#c3c3c9",
      "outline": "#71717a",
      "primary": "#fafafa",
      "secondary": "#3e3e40",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#18181b",
      "inline-code": "#fafafa",
      "error": "#e7b9b9",
      "hover": "#27272a",
      "selected": "#515154",
      "inline-area": "#1f1f22",
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
  "paseo-midnight": {
    "base": "tether-dark",
    "colors": {
      "background": "#161820",
      "on-background": "#fafafa",
      "surface": "#1c1e27",
      "surface-low": "#252731",
      "on-surface": "#fafafa",
      "on-surface-variant": "#a9acbc",
      "outline": "#6e7185",
      "primary": "#84aeec",
      "secondary": "#2a3242",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#161820",
      "inline-code": "#9dbeef",
      "error": "#dd9b9f",
      "hover": "#252731",
      "selected": "#374156",
      "inline-area": "#1c1e27",
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
  "paseo-claude": {
    "base": "tether-dark",
    "colors": {
      "background": "#1f1f1e",
      "on-background": "#fafafa",
      "surface": "#262523",
      "surface-low": "#2f2d2b",
      "on-surface": "#fafafa",
      "on-surface-variant": "#b8b4b1",
      "outline": "#7b7772",
      "primary": "#eaa38b",
      "secondary": "#413530",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#1f1f1e",
      "inline-code": "#edb29e",
      "error": "#e5a49a",
      "hover": "#2f2d2b",
      "selected": "#54433c",
      "inline-area": "#262523",
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
  "paseo-ghostty": {
    "base": "tether-dark",
    "colors": {
      "background": "#282c34",
      "on-background": "#fafafa",
      "surface": "#2f333d",
      "surface-low": "#383c48",
      "on-surface": "#fafafa",
      "on-surface-variant": "#cdd1dc",
      "outline": "#a0a4b2",
      "primary": "#b7d2fc",
      "secondary": "#424958",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#282c34",
      "inline-code": "#c6dbfc",
      "error": "#edc8cb",
      "hover": "#383c48",
      "selected": "#515a6c",
      "inline-area": "#2f333d",
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
  "paseo-pure-black": {
    "base": "tether-dark",
    "colors": {
      "background": "#000000",
      "on-background": "#fafafa",
      "surface": "#0a0a0a",
      "surface-low": "#111111",
      "on-surface": "#fafafa",
      "on-surface-variant": "#a1a1aa",
      "outline": "#71717a",
      "primary": "#7ccba0",
      "secondary": "#1a251f",
      "on-secondary": "#fafafa",
      "inverse": "#fafafa",
      "on-inverse": "#000000",
      "inline-code": "#9cd7b7",
      "error": "#d68484",
      "hover": "#111111",
      "selected": "#26362e",
      "inline-area": "#0a0a0a",
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
  }
} satisfies Record<string, ThemeDesign>;
