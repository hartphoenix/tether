/** Shared reader/Folio update trigger and formatting-menu-style popover. */
export const updateControlStyles = `
#update-package[hidden]{display:none}
#update-package{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:6px;margin:0;border:0;border-radius:4px;background:transparent;color:var(--crepe-color-outline,var(--muted));cursor:pointer}
#update-package:hover,#update-package[aria-expanded=true]{background:var(--crepe-color-hover,var(--hover))}
#update-package:focus-visible{outline:2px solid var(--crepe-color-primary,var(--accent));outline-offset:1px}
#update-package .update-dot{position:absolute;right:1px;top:1px;width:7px;height:7px;border-radius:50%;background:#e4bd58}
#update-notice[data-update-popover]:not([hidden]){position:fixed;z-index:32;top:48px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);max-height:calc(100dvh - 60px);overflow:auto;margin:0;padding:8px;border:1px solid color-mix(in srgb,var(--wm-color-outline,var(--line,GrayText)),transparent 35%);border-radius:7px;background:var(--wm-color-surface,var(--panel,Canvas));color:var(--wm-page-color,var(--text,CanvasText));box-shadow:var(--crepe-shadow-2,0 10px 28px rgb(0 0 0 / 24%));font:13px/1.5 var(--wm-font-body,system-ui,sans-serif)}
#update-notice[data-update-popover] :is(button,a){font:inherit;color:inherit;cursor:pointer}
#update-notice[data-update-popover] button{padding:6px 8px;border:0;border-radius:4px;background:transparent}
#update-notice[data-update-popover] button:hover{background:var(--wm-color-hover,var(--hover))}
`;
