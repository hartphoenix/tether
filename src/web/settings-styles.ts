/** Standalone Settings shares Folio's palette and interface scale. */
export const settingsStyles = `
body>.top,body>.folio-scroll{display:none!important}
html{height:auto;overflow:auto}
body{display:block;height:auto;min-height:100dvh;overflow:visible;padding:28px 24px;max-width:calc(760px * var(--wm-ui-scale));font-size:calc(14px * var(--wm-ui-scale));line-height:1.5}
#settings-dialog{position:static;transform:none;width:100%;max-height:none;display:block;box-shadow:none;border:0;background:transparent;padding:0;font-size:inherit;color:var(--text);overflow:visible}
#settings-title{font-size:1.8em;letter-spacing:-.03em;margin:0 0 1.25em}
#settings-dialog h3{font-size:1.15em;margin:0 0 1em;font-weight:600}
#settings-dialog h4{font-size:1em;margin:0 0 .6em;font-weight:600}
#settings-dialog p{margin:0 0 1em}
#settings-dialog .settings-hint{color:var(--muted);font-size:.9em;margin:.3em 0 1em}
.settings-section{padding:1.5em;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:1em}
#settings-dialog label{display:block;font-weight:500}
#settings-dialog input,#settings-dialog select,#settings-dialog textarea{font:inherit;color:var(--text);accent-color:var(--accent)}
#settings-dialog input:not([type=range]):not([type=checkbox]),#settings-dialog select,#settings-dialog textarea{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:.65em .8em;max-width:100%;min-width:0}
#settings-dialog label>input:not([type=checkbox]){display:block;width:100%;margin-top:.4em}
#settings-dialog label:has(input[type=checkbox]){display:flex;align-items:flex-start;gap:.65em;font-weight:400;margin:1em 0}
#settings-dialog input[type=checkbox]{order:-1;flex:0 0 auto;width:1.15em;height:1.15em;margin:.2em 0}
#settings-dialog .scale-row{margin:.5em 0 1.3em;gap:1em;flex-wrap:nowrap}
#settings-dialog .scale-row:last-child{margin-bottom:0}
#settings-dialog input[type=range]{min-height:36px;min-width:0;width:100%;margin:0}
#settings-dialog output{font-variant-numeric:tabular-nums;text-align:right;min-width:4em;color:var(--muted)}
#settings-dialog .settings-row{flex-wrap:wrap;margin-top:.5em}
#settings-dialog .settings-row select{flex:1}
#settings-dialog .settings-row input{width:6em}
#settings-dialog button,.settings-confirm button{font:inherit;min-height:40px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:.55em .9em;color:var(--text);white-space:normal}
#settings-dialog button:hover:not(:disabled),.settings-confirm button:hover:not(:disabled){background:var(--hover)}
#settings-dialog button:disabled{opacity:.5;cursor:default}
#settings-dialog button.primary{background:var(--selected);border-color:var(--accent);color:var(--accent)}
#settings-dialog :is(input,select,textarea,a,summary):focus-visible{outline:2px solid var(--accent);outline-offset:3px}
#settings-dialog .dialog-actions,.settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:.6em;margin:1em 0 0}
#settings-feedback{margin-right:auto;color:var(--muted);font-size:.9em}
#fly-settings{margin-top:2.5em;padding-top:2em;border-top:1px solid var(--line)}
#fly-settings .settings-actions{margin-bottom:1em}
#fly-settings a{color:var(--accent);overflow-wrap:anywhere}
#fly-settings details{border-top:1px solid var(--line);padding:1em 0}
#fly-settings summary{cursor:pointer;font-weight:500;padding:.3em 0}
#fly-settings details[open]>summary{margin-bottom:1em}
#fly-settings .settings-section details:last-child{padding-bottom:0}
#fly-settings .settings-section{margin-top:1em}
#fly-settings select,#fly-settings textarea{display:block;width:100%;margin:.5em 0 1em}
#fly-settings form{margin-top:1em}
#fly-settings textarea{resize:vertical;line-height:1.5}
#fly-settings .machine-preview{font: .85em/1.5 ui-monospace,monospace;overflow-wrap:anywhere;color:var(--muted);margin:1em 0}
#fly-settings .machine-table{width:100%;border-collapse:collapse;font-size:.9em}
#fly-settings .machine-table :is(th,td){text-align:left;padding:.65em .5em;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
#fly-settings .machine-table th{font-weight:500}
#fly-settings .machine-table thead{color:var(--muted);font-size:.9em}
#fly-settings .machine-table :is(th,td):first-child{padding-left:0}
#fly-settings .machine-table :is(th,td):last-child{padding-right:0;width:1%;white-space:nowrap}
#fly-settings .machine-table button{min-height:34px;padding:.35em .65em;white-space:nowrap;overflow-wrap:normal}
#fly-settings .client-row{display:flex;flex-wrap:wrap;align-items:center;gap:.7em;margin:1em 0}
#fly-settings .client-row>span{flex:1;min-width:12em;overflow-wrap:anywhere}
#fly-settings .client-row>select{flex-basis:100%}
#fly-feedback{position:sticky;bottom:1em;background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:.8em 1em;margin-top:1em}
#fly-feedback:empty{display:none}
.settings-confirm{max-width:min(32em,calc(100% - 2em));background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:1.5em}
.settings-confirm::backdrop{background:#0008}
.settings-confirm button{display:block;width:100%;margin-top:.7em}
@media(max-width:480px){body{padding:20px 12px}.settings-section{padding:1em}#settings-dialog .dialog-actions>button{flex:1}#settings-feedback{flex-basis:100%}}
`;
