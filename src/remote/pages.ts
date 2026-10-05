export const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Tether"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>${escapeHtml(title)}</title><style>body{font:18px system-ui;line-height:1.5;max-width:36rem;margin:3rem auto;padding:0 1rem}button,input{font:inherit;padding:.6rem;margin:.5rem 0}button{cursor:pointer}label{display:block}a{overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function approvalPage(requestId: string, title: string, enrolled: boolean): string {
  return page("Open Tether on this device", `<p>Read and comment on <strong>${escapeHtml(title)}</strong> for one hour.</p><p>This does not authorize an agent or allow document edits.</p>${enrolled ? `<button id="authenticate" data-request="${escapeHtml(requestId)}">Verify with passkey</button>` : "<p>Set up your passkey at the Mac first.</p>"}<p id="status" role="status"></p><script type="module" src="/auth.js"></script>`);
}

export function enrollmentPage(): string {
  return page("Set up your Tether passkey", `<p>Enter the one-time setup code shown by the command you started at your Mac.</p><label>Setup code <input id="setup-code" type="password" autocomplete="off"></label><button id="register">Create passkey</button><p id="status" role="status"></p><script type="module" src="/auth.js"></script>`);
}
