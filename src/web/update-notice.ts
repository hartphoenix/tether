/** Serialized into the standalone Folio page; keep this function self-contained. */
export function mountUpdateNotice(element: HTMLElement, api: string, reportError?: (message: string) => void, beforeInstall?: () => Promise<void>, reload = true): void {
  let pending = false;
  let installing = false;
  let started = 0;
  const message = (text: string) => { element.hidden = false; element.textContent = text; };
  const post = async (action: string, tag: string) => {
    const response = await fetch(`${api}/updates/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag }) });
    if (!response.ok) throw new Error("Update action failed");
  };
  const check = async (force = false) => {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch(`${api}/updates${force ? "/check" : ""}`, { cache: "no-store", ...(force ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("Unavailable");
      const state = await response.json();
      if (state.installing) { installing = true; started ||= Date.now(); message("Installing Tether update…"); return; }
      if (installing) {
        installing = false;
        if (!state.failed && !state.available) { if (reload) location.reload(); else message("Tether updated. Your document remains open."); return; }
      }
      const update = state.available;
      const checkButton = document.createElement("button");
      checkButton.textContent = "Check for updates";
      checkButton.onclick = () => void check(true);
      if (!update) {
        if (!state.managed) { element.hidden = true; return; }
        const text = state.failed ? "Update failed. Run tether doctor. " : state.prolongedFailure ? "Updates have not verified for over a day. " : force ? (state.checkFailed ? "Could not verify updates. " : "No newer verified release. ") : "";
        element.hidden = false;
        element.replaceChildren(document.createTextNode(text), checkButton);
        return;
      }
      element.hidden = false;
      element.replaceChildren(document.createTextNode(state.failed ? "Update failed. " : ""), document.createTextNode(`Tether update available: version ${update.version}. `));
      const install = document.createElement("button");
      install.textContent = "Install";
      install.onclick = async () => {
        install.disabled = true;
        installing = true;
        started = Date.now();
        message("Installing Tether update…");
        try { await beforeInstall?.(); await post("install", update.tag); }
        catch { installing = false; (reportError ?? message)("Could not start update. Try again shortly."); }
        void check();
      };
      const notes = document.createElement("a");
      notes.textContent = "Release Notes";
      notes.href = update.notes;
      notes.target = "_blank";
      notes.rel = "noopener noreferrer";
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      dismiss.onclick = async () => {
        dismiss.disabled = true;
        try { await post("dismiss", update.tag); element.hidden = true; }
        catch { dismiss.disabled = false; (reportError ?? message)("Could not dismiss the update notice. Try again shortly."); }
      };
      element.append(install, " | ", notes, " | ", dismiss, " | ", checkButton);
    } catch {
      if (installing && Date.now() - started > 300_000) message("Update is taking longer. Run tether to reconnect.");
      // Failed passive checks never interrupt work or erase an existing notice.
    } finally { pending = false; }
  };
  void check();
  setInterval(() => { if (installing) void check(); }, 2000);
  setInterval(() => void check(), 60_000);
  addEventListener("pageshow", () => void check());
  document.addEventListener("visibilitychange", () => void check());
}
