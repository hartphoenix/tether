/** One comment composer skin for the reader and the Paseo adapter. */
export const commentWindowCss = `
:root .tether-comment-window.tether-comment-window.tether-comment-window {
  box-sizing:border-box; width:min(340px,calc(100vw - 24px)); padding:10px;
  border:1px solid var(--tc-border,color-mix(in srgb,var(--wm-color-outline,#818580),transparent 65%));
  border-radius:8px; background:var(--tc-surface,var(--wm-color-surface,#eeece6));
  color:var(--tc-text,var(--wm-color-on-background,#343a40));
  box-shadow:0 2px 8px rgb(0 0 0 / 24%); font:13px/1.5 system-ui,sans-serif;
}
:root .tether-comment-window.tether-comment-window.tether-comment-window form { margin:0; }
:root .tether-comment-window.tether-comment-window.tether-comment-window textarea {
  display:block; box-sizing:border-box; width:100%; height:96px; min-height:64px;
  padding:9px 10px; border:1px solid var(--tc-border,color-mix(in srgb,var(--wm-color-outline,#818580),transparent 65%));
  border-radius:7px; background:var(--tc-input,var(--wm-color-background,#f5f3ee));
  color:inherit; font:var(--wm-comment-text-size,16px)/1.6 system-ui,sans-serif;
  resize:vertical; user-select:text; touch-action:auto; cursor:text;
}
:root .tether-comment-window.tether-comment-window.tether-comment-window textarea::placeholder { color:var(--tc-muted,var(--wm-color-on-surface-variant,#62676b)); opacity:.85; }
:root .tether-comment-window.tether-comment-window.tether-comment-window textarea:focus { outline:none; }
:root .tether-comment-window.tether-comment-window.tether-comment-window .tether-comment-actions { display:flex; justify-content:flex-end; gap:8px; margin:7px 0 0; }
:root .tether-comment-window.tether-comment-window.tether-comment-window button {
  box-sizing:border-box; min-height:30px; padding:4px 10px; border:1px solid var(--tc-outline,var(--wm-color-outline,#818580));
  border-radius:6px; color:inherit; background:var(--tc-control,var(--wm-color-surface-low,#e9e7e0));
  font:12px/1.5 system-ui,sans-serif; cursor:pointer;
}
:root .tether-comment-window.tether-comment-window.tether-comment-window button[data-primary] { border-color:transparent; color:var(--tc-on-primary,var(--wm-color-on-secondary,#154a4b)); background:var(--tc-primary,var(--wm-color-secondary,#d5e7e3)); }
:root .tether-comment-window.tether-comment-window.tether-comment-window button:focus-visible { outline:2px solid var(--tc-outline,var(--wm-color-outline,#818580)); outline-offset:1px; }
:root .tether-comment-window.tether-comment-window.tether-comment-window button:disabled { opacity:.6; cursor:default; }
:root .tether-comment-window.tether-comment-window.tether-comment-window [role=status]:empty { display:none; }
`;
