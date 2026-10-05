import type { FolioView } from "../shared/contracts";

// Experimental desktop adapter: Paseo has no public embedded-browser component.
// Keep DOM access here, without adding DOM/Electron dependencies to the plugin.
type GuestEvent = { url?: string; httpResponseCode?: number; isMainFrame?: boolean; isInPlace?: boolean; errorCode?: number };
type Listener = (event: GuestEvent) => void;
type Guest = {
  style: { width: string; height: string; display: string; flex: string };
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, listener: Listener): void;
  removeEventListener(name: string, listener: Listener): void;
  remove(): void;
};
declare const document: { createElement(name: "webview"): Guest } | undefined;

type Container = { appendChild(guest: Guest): unknown };
export type FolioViewState = "loading" | "ready" | "failed";
/** Folio sessions live under `/r/`, reader sessions under `/s/`. */
export type ViewKind = "folio" | "reader";
type MountOptions = {
  kind?: ViewKind;
  cacheKey: string;
  launch: () => Promise<FolioView>;
  onState: (state: FolioViewState) => void;
  /** A session saved by the caller, tried when this client has none cached. */
  saved?: string;
  /** Reports the cached session as it is committed or discarded. */
  onSession?: (url: string | undefined) => void;
  /** Launch fresh, skipping any cached session. */
  fresh?: boolean;
  launchTimeoutMs?: number;
  loadTimeoutMs?: number;
};
const launchPaths: Record<ViewKind, string> = { folio: "/recents/launch", reader: "/launch" };
const sessionPaths: Record<ViewKind, RegExp> = { folio: /^\/r\/[A-Za-z0-9_-]+\/$/, reader: /^\/s\/[A-Za-z0-9_-]+\/$/ };

const sessions = new Map<string, string>();
const mounts = new Set<() => void>();

/** Connection settings and workspace are both part of a Folio session's identity. */
export function folioViewKey(hostId: string, tetherPath: string, profile: string, workspaceId: string): string {
  return JSON.stringify([hostId, tetherPath, profile, workspaceId]);
}

/** Called on plugin teardown; late RPCs cannot repopulate the next installation's cache. */
export function disposeFolioViews(): void {
  for (const dispose of [...mounts]) dispose();
  sessions.clear();
}

// A reader launch may target a heading; Folio URLs never carry a fragment.
function localUrl(value: string, kind: ViewKind): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || (url.hash && kind !== "reader")) throw new Error("Invalid Tether URL");
  return url;
}

function sessionUrl(value: string, origin: string, kind: ViewKind): string {
  const url = localUrl(value, kind);
  // A heading belongs to one launch, not to the session a later mount reloads.
  url.hash = "";
  if (url.origin !== origin || !sessionPaths[kind].test(url.pathname)
    || [...url.searchParams.keys()].some(key => key !== "instance")) throw new Error("Invalid Tether session");
  return url.href;
}

function launchUrl(value: string, kind: ViewKind): URL {
  const url = localUrl(value, kind);
  const themeClient = url.searchParams.get("themeClient");
  const surfaces = url.searchParams.getAll("surface");
  const allowed = kind === "reader" ? ["ticket", "themeClient", "surface"] : ["ticket", "themeClient"];
  if (url.pathname !== launchPaths[kind] || url.searchParams.getAll("ticket").length !== 1 || !url.searchParams.get("ticket")
    || url.searchParams.getAll("themeClient").length > 1
    || (themeClient !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(themeClient))
    || surfaces.length > 1 || surfaces.some(surface => surface !== "panel")
    || [...url.searchParams.keys()].some(key => !allowed.includes(key))) throw new Error("Invalid Tether launch");
  return url;
}

/** One guest per mount; cache only authenticated final URLs, never consumable tickets. */
export function mountFolioWebview(container: unknown, options: MountOptions): () => void {
  const kind = options.kind ?? "folio";
  let disposed = false;
  let stopAttempt = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopAttempt();
    mounts.delete(dispose);
  };
  mounts.add(dispose);

  function begin(cached?: string): void {
    stopAttempt();
    options.onState("loading");
    let active = true;
    let guest: Guest | undefined;
    let finalUrl: string | undefined;
    let committedUrl: string | undefined;
    let domReady = false;
    const listeners = new Map<string, Listener>();
    let timer: ReturnType<typeof setTimeout>;
    const live = () => active && !disposed;
    const stop = () => {
      active = false;
      clearTimeout(timer);
      if (guest) {
        for (const [name, listener] of listeners) guest.removeEventListener(name, listener);
        guest.remove();
      }
    };
    stopAttempt = stop;
    const fail = () => {
      if (!live()) return;
      const failedUrl = committedUrl ?? cached;
      if (failedUrl && sessions.get(options.cacheKey) === failedUrl) sessions.delete(options.cacheKey);
      if (failedUrl) options.onSession?.(undefined);
      stop();
      // Only a failed cached session gets one automatic fresh launch.
      if (cached) begin();
      else options.onState("failed");
    };
    timer = setTimeout(fail, cached ? options.loadTimeoutMs ?? 5_000 : options.launchTimeoutMs ?? 15_000);

    const attach = (value: string) => {
      if (!live()) return;
      try {
        const url = cached ? localUrl(value, kind) : launchUrl(value, kind);
        if (cached) sessionUrl(value, url.origin, kind);
        if (typeof document === "undefined" || !container || typeof (container as Container).appendChild !== "function") throw new Error("Webview unavailable");
        guest = document.createElement("webview");
        const listen = (name: string, listener: Listener) => {
          listeners.set(name, listener);
          guest!.addEventListener(name, listener);
        };
        const ready = () => {
          if (!live() || !domReady || !finalUrl) return;
          clearTimeout(timer);
          sessions.set(options.cacheKey, finalUrl);
          committedUrl = finalUrl;
          options.onSession?.(finalUrl);
          options.onState("ready");
        };
        listen("did-start-navigation", event => {
          if (!live() || !event.isMainFrame || event.isInPlace) return;
          domReady = false;
          finalUrl = undefined;
          clearTimeout(timer);
          timer = setTimeout(fail, options.loadTimeoutMs ?? 5_000);
        });
        listen("did-frame-navigate", event => {
          if (!live() || !event.isMainFrame) return;
          try {
            if (!event.httpResponseCode || event.httpResponseCode < 200 || event.httpResponseCode >= 300) throw new Error("Tether navigation failed");
            finalUrl = sessionUrl(event.url ?? "", url.origin, kind);
            ready();
          } catch { fail(); }
        });
        listen("dom-ready", () => { if (live()) { domReady = true; ready(); } });
        listen("did-fail-load", event => {
          if (!live() || !event.isMainFrame) return;
          if (event.errorCode !== -3) { fail(); return; }
          // A cancelled navigation leaves the previously committed page usable.
          // With no ready page yet, retain the initial-load deadline.
          if (committedUrl) {
            clearTimeout(timer);
            finalUrl = committedUrl;
            domReady = true;
          }
        });
        listen("render-process-gone", fail);
        listen("destroyed", fail);
        guest.setAttribute("partition", "persist:paseo-browser");
        Object.assign(guest.style, { width: "100%", height: "100%", display: "flex", flex: "1" });
        guest.setAttribute("src", url.href);
        clearTimeout(timer);
        timer = setTimeout(fail, options.loadTimeoutMs ?? 5_000);
        (container as Container).appendChild(guest);
      } catch { fail(); }
    };
    if (cached) attach(cached);
    else {
      // Separate requests for concurrent mounts: sharing a one-use ticket races its exchange.
      void Promise.resolve().then(() => live() ? options.launch() : undefined).then(launch => {
        if (!live() || !launch) return;
        if (!Number.isFinite(launch.expiresAt) || launch.expiresAt <= Date.now()) { fail(); return; }
        attach(launch.url);
      }).catch(fail);
    }
  }

  if (options.fresh) sessions.delete(options.cacheKey);
  begin(options.fresh ? undefined : sessions.get(options.cacheKey) ?? options.saved);
  return dispose;
}
