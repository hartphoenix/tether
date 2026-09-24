/** Session routes contain identifiers, never authority. Recovery reuses cookies. */
export type RecoveryView = { id: string; kind: "document" | "folio"; url: string };
export type RecoverySurface = { windowId: string; workspaceId: string; surfaceId: string; url: string };
export type RecoveryResult = { surfaceId: string; viewId?: string; status: "navigated" | "eligible" | "skipped"; reason: string };
export type RecoveryReport = { inspected: number; results: RecoveryResult[] };

export function recoveryRoute(raw: string): { id: string; kind: RecoveryView["kind"] } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) return null;
    const match = /^\/(s|r)\/([A-Za-z0-9_-]{1,128})\/$/.exec(url.pathname);
    if (!match || [...url.searchParams.keys()].some(key => key !== "instance") ||
        (url.hash && url.hash !== "#tether-chromeless")) return null;
    return { id: match[2]!, kind: match[1] === "s" ? "document" : "folio" };
  } catch { return null; }
}

/** Runs as ONE browser task: no asynchronous gap between guard and navigation.
 * Unknown/native pages that cannot be positively identified are never reloaded.
 * The return value contains no page contents, credentials, or document paths. */
export function recoveryPage(source: string, destination: string, inspect: boolean): string {
  const state = globalThis as typeof globalThis & { __tetherRecoveryPending?: boolean };
  if (state.__tetherRecoveryPending) return "navigation_pending";
  if (location.href !== source) return "location_changed";
  if (document.querySelector(".ProseMirror, #editor, .folio-scroll")) return "mounted";
  if (document.readyState !== "complete") return "loading";
  // Only a Tether JSON error document is an affirmative, non-editor state.
  if (document.contentType !== "application/json") return "unknown_page";
  let code: unknown;
  try { code = JSON.parse(document.body?.textContent ?? "").error?.code; } catch { return "unknown_page"; }
  if (!["unauthorized", "session_expired", "service_unavailable", "service_stopping"].includes(String(code))) return "unknown_page";
  if (["unauthorized", "session_expired"].includes(String(code)) && new URL(source).origin === new URL(destination).origin) return "authorization_required";
  if (inspect) return "eligible";
  state.__tetherRecoveryPending = true;
  location.replace(destination);
  return "navigated";
}

export function recoveryScript(source: string, destination: string, inspect: boolean): string {
  return `(${recoveryPage.toString()})(${JSON.stringify(source)},${JSON.stringify(destination)},${inspect})`;
}
