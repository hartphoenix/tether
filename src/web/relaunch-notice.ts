/** Self-contained so the standalone Folio page can embed the same renderer. */
export function renderRelaunchNotice(element: HTMLElement, message: string): boolean {
  const match = message.match(/Placement unavailable\. In cmux, run: `([^`]+)`/);
  if (!match) return false;
  const doc = element.ownerDocument;
  element.textContent = "";
  const existing = doc.querySelector<HTMLDialogElement>("dialog[data-tether-relaunch]");
  if (existing) return true;
  const previousFocus = doc.activeElement as HTMLElement | null;
  const dialog = doc.createElement("dialog");
  dialog.dataset.tetherRelaunch = "true";
  dialog.setAttribute("aria-label", "Placement unavailable");
  dialog.setAttribute("aria-describedby", "tether-relaunch-instructions");
  dialog.style.cssText = "position:fixed;inset:0;margin:auto;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:22px;border:1px solid var(--line,GrayText);border-radius:12px;background:var(--panel2,Canvas);color:var(--text,CanvasText);box-shadow:0 12px 40px #0005;font:14px system-ui;z-index:1000";
  const title = doc.createElement("h2");
  title.textContent = "Placement unavailable";
  title.style.cssText = "font-size:18px;margin:0 0 12px";
  const instructions = doc.createElement("p");
  instructions.id = "tether-relaunch-instructions";
  instructions.textContent = "Run this command in a cmux terminal, then try opening the document again.";
  const code = doc.createElement("code");
  code.textContent = match[1]!;
  code.style.cssText = "display:block;user-select:all;overflow-wrap:anywhere;white-space:pre-wrap;padding:12px 0";
  const feedback = doc.createElement("p");
  feedback.setAttribute("role", "status");
  feedback.style.cssText = "margin:8px 0";
  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px";
  const copy = doc.createElement("button");
  copy.textContent = "Copy";
  copy.onclick = async () => {
    copy.disabled = true;
    try {
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error("Clipboard unavailable");
      await clipboard.writeText(match[1]!);
      copy.textContent = "Copied";
      feedback.textContent = "Copied";
    } catch {
      copy.textContent = "Copy";
      feedback.textContent = "Could not copy. Select the command and copy it manually.";
    } finally { copy.disabled = false; }
  };
  const close = doc.createElement("button");
  close.textContent = "Close";
  const dismiss = () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  close.onclick = dismiss;
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  for (const button of [copy, close]) {
    button.type = "button";
    button.style.cssText = "font:inherit;color:inherit;background:var(--panel,ButtonFace);border:1px solid var(--line,GrayText);border-radius:6px;padding:8px 12px;cursor:pointer";
  }
  actions.append(copy, close);
  dialog.append(title, instructions, code, feedback, actions);
  doc.body.append(dialog);
  dialog.showModal();
  copy.focus({ preventScroll: true });
  return true;
}
