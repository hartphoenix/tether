import { viewIsVisible } from "./view-activity";
import type { TurnAgent } from "./turn-button";

/** EventSource resumes itself after sleep or service restart without model work. */
export function subscribeTurns(url: string, update: (value: { agents: TurnAgent[]; identityRevision?: number }) => void): () => void {
  let source: EventSource | undefined;
  const close = () => { source?.close(); source = undefined; };
  const open = () => {
    if (source || !viewIsVisible()) return;
    source = new EventSource(url);
    source.addEventListener("turns", event => {
      try {
        const value = JSON.parse((event as MessageEvent).data);
        if (Array.isArray(value.agents)) update(value);
      } catch { /* The next reconnect snapshot remains authoritative. */ }
    });
  };
  const visibility = () => { if (!viewIsVisible()) close(); else open(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("tether-host-state", visibility);
  window.addEventListener("pagehide", close);
  window.addEventListener("pageshow", open);
  open();
  return () => { close(); window.removeEventListener("tether-host-state", visibility); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", close); window.removeEventListener("pageshow", open); };
}
