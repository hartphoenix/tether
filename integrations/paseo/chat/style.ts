export const chatCss = `
[data-tether-chat] { box-sizing:border-box; color:var(--colors-foreground); font:13px system-ui; }
[data-tether-chat] button { font:inherit; color:inherit; background:transparent; border:1px solid var(--colors-border); border-radius:6px; padding:5px 8px; cursor:pointer; }
[data-tether-chat] button:hover { background:var(--colors-surface2); }
[data-tether-chat] button:focus-visible,[data-tether-chat] textarea:focus-visible { outline:2px solid var(--colors-accent); outline-offset:2px; }
[data-tether-chat] button:disabled { opacity:.5; cursor:default; }
[data-tether-chat="menu"] { position:fixed; z-index:2147483000; background:var(--colors-surface1); border:1px solid var(--colors-border-accent); border-radius:8px; box-shadow:0 4px 16px color-mix(in srgb,var(--colors-foreground) 14%,transparent); padding:8px; }
[data-tether-chat="menu"] { display:flex; gap:4px; }
[data-tether-chat="menu"] button { width:30px; height:30px; padding:4px; }
[data-tether-chat] svg { width:20px; height:20px; display:block; }
[data-tether-chat="card"] { position:fixed; z-index:2147483000; width:340px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto; touch-action:none; user-select:none; }
[data-tether-chat="badge"] { position:absolute; z-index:5; border:1px solid var(--colors-surface0); border-radius:5px; padding:0 4px; min-width:19px; height:19px; line-height:17px; font-weight:700; background:var(--tc-annotation,var(--colors-accent)); color:var(--tc-on-annotation,var(--colors-accent-foreground)); cursor:pointer; user-select:none; }
[data-tether-chat="batch"] { margin:-8px -12px; min-width:280px; max-width: min(480px,calc(100vw - 32px)); }
[data-tether-chat="batch"] ol { margin:0; padding:0; list-style:none; max-height:320px; overflow:auto; }
[data-tether-chat="batch"] li { display:flex; align-items:center; min-height:32px; margin:0 4px; padding:4px 8px; gap:4px; border-radius:6px; }
[data-tether-chat="batch"] li:hover,[data-tether-chat="batch"] li:focus-within { background:var(--colors-surface2); }
[data-tether-chat="batch"] li button { border:0; background:transparent; padding:0; }
[data-tether-chat="batch"] .tether-collection-edit { display:flex; align-items:center; gap:8px; flex:1; min-width:0; text-align:left; }
.tether-collection-number { min-width:18px; height:18px; padding:0 4px; border-radius:9px; background:var(--colors-accent); color:var(--colors-accent-foreground); font:600 11px/18px system-ui; text-align:center; }
.tether-collection-label { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:14px; }
.tether-collection-label:has(+ .tether-collection-quote) { max-width:66%; flex-shrink:0; }
.tether-collection-quote { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; color:var(--colors-foreground-muted); }
[data-tether-chat="batch"] .tether-collection-delete { opacity:0; padding:4px; color:var(--colors-foreground-muted); }
[data-tether-chat="batch"] li:hover .tether-collection-delete,[data-tether-chat="batch"] li:focus-within .tether-collection-delete { opacity:1; }
[data-tether-chat="batch"] .tether-collection-delete svg { width:14px; height:14px; }
@media (hover:none) { [data-tether-chat="batch"] .tether-collection-delete { opacity:1; } }
[data-tether-chat="batch"] > p { margin:4px 12px; color:var(--colors-foreground-muted); }
[data-tether-chat="batch"] > p:empty { display:none; }
[data-tether-chat="batch"] > div { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:8px; margin-top:4px; padding:4px 12px; border-top:1px solid var(--colors-border); }
[data-tether-chat="batch"] > div button { border-color:transparent; border-radius:12px; min-height:32px; padding:0 12px; font-size:14px; color:var(--colors-foreground-muted); }
::highlight(tether-chat-pending) { background:color-mix(in srgb,var(--colors-accent) 24%,transparent); }
`;
