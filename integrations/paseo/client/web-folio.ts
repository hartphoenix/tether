import { observePaneVisibility } from "./view-visibility";
import { nativePasteScript } from "./native-paste";
import { getState, subscribeState } from "./state";
import type { FolioView } from "../shared/contracts";

// Experimental desktop adapter: Paseo has no public embedded-browser component.
// Keep DOM access here, without adding DOM/Electron dependencies to the plugin.
type GuestEvent = { message?: string; sourceId?: string; url?: string; httpResponseCode?: number; isMainFrame?: boolean; isInPlace?: boolean; errorCode?: number };
type Listener = (event: GuestEvent) => void;
type Guest = {
  style: { width: string; height: string; display: string; flex: string };
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, listener: Listener): void;
  removeEventListener(name: string, listener: Listener): void;
  remove(): void;
  executeJavaScript?(script: string): Promise<unknown>;
  paste?(): void | Promise<void>;
  getWebContentsId?(): number;
  dispatchEvent?(event: Event): boolean;
};
declare const document: { createElement(name: "webview"): Guest } | undefined;
type BrowserRegistration = { browserId: string; workspaceId: string; webContentsId: number };
declare const window: { paseoDesktop?: { browser?: { registerAttachedBrowser?: (input: BrowserRegistration) => unknown } } } | undefined;

type Container = { appendChild(guest: Guest): unknown };
export type FolioViewState = "loading" | "ready" | "failed";
/** Folio sessions live under `/r/`, reader sessions under `/s/`. */
export type ViewKind = "folio" | "reader";
type MountOptions = {
  kind?: ViewKind;
  cacheKey: string;
  /** Lets Paseo forward its shortcuts from this view; see `registerShortcuts`. */
  workspaceId?: string;
  launch: () => Promise<FolioView>;
  onState: (state: FolioViewState) => void;
  onOpenBrowser?: (url: string) => void;
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
    || [...url.searchParams.keys()].some(key => key !== "instance" && key !== "embedded")) throw new Error("Invalid Tether session");
  return url.href;
}

function launchUrl(value: string, kind: ViewKind): URL {
  const url = localUrl(value, kind);
  const themeClient = url.searchParams.get("themeClient");
  const surfaces = url.searchParams.getAll("surface");
  const allowed = kind === "reader" ? ["ticket", "themeClient", "surface"] : ["ticket", "themeClient", "embedded"];
  const embedded = url.searchParams.getAll("embedded");
  if (url.pathname !== launchPaths[kind] || url.searchParams.getAll("ticket").length !== 1 || !url.searchParams.get("ticket")
    || url.searchParams.getAll("themeClient").length > 1
    || (themeClient !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(themeClient))
    || surfaces.length > 1 || surfaces.some(surface => surface !== "panel")
    || embedded.length > 1 || embedded.some(value => value !== "1")
    || [...url.searchParams.keys()].some(key => !allowed.includes(key))) throw new Error("Invalid Tether launch");
  return url;
}

// Paseo forwards its app shortcuts, and reloads the view on ⌘R, only for webviews registered as its
// browsers. Its private bridge accepts any webview in its window using its browser profile, and drops
// the registration when the webview is destroyed. Without it, the view keeps every shortcut and ⌘R
// reloads the whole app. Registration also lists the view in agents' browser tools, as Paseo's own
// browser tabs already are.
function registerShortcuts(guest: Guest, browserId: string, workspaceId: string | undefined): void {
  const register = typeof window === "undefined" ? undefined : window.paseoDesktop?.browser?.registerAttachedBrowser;
  if (!workspaceId || typeof register !== "function" || typeof guest.getWebContentsId !== "function") return;
  try { void Promise.resolve(register({ browserId, workspaceId, webContentsId: guest.getWebContentsId() })).catch(() => {}); }
  catch {}
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
    let sharedOrigin: string | undefined;
    stopAttempt();
    options.onState("loading");
    let active = true;
    let guest: Guest | undefined;
    let finalUrl: string | undefined;
    let committedUrl: string | undefined;
    let domReady = false;
    let pasteChannel: string | undefined;
    let pasteSequence = 0;
    const listeners = new Map<string, Listener>();
    let visible = true;
    let lastHostState = "";
    let stopVisibility = () => {};
    let stopState = () => {};
    const sendHostState = () => {
      if (!live() || !domReady || !finalUrl || !guest?.executeJavaScript) return;
      const state = getState();
      // The plugin's authenticated shared connection carries only an invalidation
      // token here. Each page still fetches through its own scoped session.
      const folioRevision = visible && kind === "folio" && state.status.connected && !sharedOrigin && state.folioRevision !== undefined
        ? JSON.stringify([state.connection?.generation, state.status.tether, state.folioRevision]) : undefined;
      const payload = JSON.stringify({ visible, folioRevision });
      if (payload === lastHostState) return;
      lastHostState = payload;
      const retryOnNextState = () => { if (lastHostState === payload) lastHostState = ""; };
      try {
        void guest.executeJavaScript(`window.__tetherHostState = ${payload}; window.dispatchEvent(new Event("tether-host-state"));`).catch(retryOnNextState);
      } catch { retryOnNextState(); }
    };
    let timer: ReturnType<typeof setTimeout>;
    const live = () => active && !disposed;
    const stop = () => {
      active = false;
      clearTimeout(timer);
      stopVisibility();
      stopState();
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
    timer = setTimeout(fail, cached ? options.loadTimeoutMs ?? (sharedOrigin ? 120_000 : 5_000) : options.launchTimeoutMs ?? 15_000);

    const sharedUrl = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== sharedOrigin || url.username || url.password || url.hash
        || !/^(?:\/folio\/?|\/settings\/?|\/auth\/login|\/reader\/d\/[a-f0-9-]{36}\/)$/.test(url.pathname)
        || [...url.searchParams.keys()].some(key => key !== "next" && key !== "themeClient" && key !== "embedded")
        || url.searchParams.has("themeClient") && !/^[a-f0-9-]{36}$/i.test(url.searchParams.get("themeClient")!)) throw new Error("Invalid shared Folio address");
      if (url.searchParams.has("next")) {
        const next = new URL(url.searchParams.get("next")!, sharedOrigin);
        if (next.origin !== sharedOrigin || !/^\/(?:folio|settings)\/?$/.test(next.pathname) || [...next.searchParams.keys()].some(key => key !== "themeClient" && key !== "embedded") || next.hash) throw new Error("Invalid sign-in destination");
      }
      return url;
    };
    const attach = (value: string) => {
      if (!live()) return;
      try {
        const url = sharedOrigin ? sharedUrl(value) : cached ? localUrl(value, kind) : launchUrl(value, kind);
        if (sharedOrigin) { if (url.pathname !== "/folio/") throw new Error("Invalid shared Folio launch"); }
        else if (cached) sessionUrl(value, url.origin, kind);
        if (typeof document === "undefined" || !container || typeof (container as Container).appendChild !== "function") throw new Error("Webview unavailable");
        guest = document.createElement("webview");
        const listen = (name: string, listener: Listener) => {
          listeners.set(name, listener);
          guest!.addEventListener(name, listener);
        };
        const ready = () => {
          if (!live() || !domReady || !finalUrl) return;
          clearTimeout(timer);
          if (!sharedOrigin) sessions.set(options.cacheKey, finalUrl);
          committedUrl = finalUrl;
          options.onSession?.(finalUrl);
          options.onState("ready");
          sendHostState();
          if (!pasteChannel && guest?.paste && guest.executeJavaScript) {
            const channel = `tether:native-paste:${crypto.randomUUID()}:`;
            pasteChannel = channel;
            pasteSequence = 0;
            try {
              void guest.executeJavaScript(nativePasteScript(channel)).catch(() => {
                if (pasteChannel === channel) pasteChannel = undefined;
              });
            } catch { pasteChannel = undefined; }
          }
        };
        // webview will-navigate cannot be cancelled. The page emits a bounded
        // console-message request instead; no preload or Node access is needed.
        listen("console-message", event => {
          if (live() && domReady && committedUrl === finalUrl && pasteChannel && event.message?.startsWith(pasteChannel)) {
            const value = event.message.slice(pasteChannel.length);
            const sequence = Number(value);
            if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(sequence) || sequence <= pasteSequence) return;
            pasteSequence = sequence;
            // The guest cancelled this key's default action. Invoke native paste once,
            // bypassing Paseo's mutable menu gate; never retry an uncertain insertion.
            try { void Promise.resolve(guest?.paste?.()).catch(() => {}); }
            catch { /* A destroyed guest cannot accept a paste. */ }
            return;
          }
          const prefix = "tether:open-browser:";
          if (!live() || !domReady || !committedUrl || !options.onOpenBrowser || !event.message?.startsWith(prefix)) return;
          try {
            const current = new URL(committedUrl), source = new URL(event.sourceId ?? "");
            if (source.origin !== current.origin || source.pathname !== current.pathname) return;
            const target = sharedOrigin ? sharedUrl(event.message.slice(prefix.length)) : localUrl(event.message.slice(prefix.length), kind);
            if (sharedOrigin) {
              if (current.pathname !== "/folio/" || !(target.pathname === "/settings/" || target.pathname.startsWith("/reader/")) || target.searchParams.has("next")) return;
              target.searchParams.delete("embedded");
            } else if (target.origin !== current.origin || target.pathname !== current.pathname + "settings" || target.search) return;
            options.onOpenBrowser(target.href);
          } catch { /* Ignore unrelated or invalid guest messages without replacing Folio. */ }
        });
        listen("did-start-navigation", event => {
          if (!live() || !event.isMainFrame || event.isInPlace) return;
          domReady = false;
          pasteChannel = undefined;
          lastHostState = "";
          finalUrl = undefined;
          clearTimeout(timer);
          timer = setTimeout(fail, options.loadTimeoutMs ?? (sharedOrigin ? 120_000 : 5_000));
        });
        listen("did-frame-navigate", event => {
          if (!live() || !event.isMainFrame) return;
          try {
            if (!event.httpResponseCode || event.httpResponseCode < 200 || event.httpResponseCode >= 300) throw new Error("Tether navigation failed");
            finalUrl = sharedOrigin ? sharedUrl(event.url ?? "").href : sessionUrl(event.url ?? "", url.origin, kind);
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
        // A reattached guest gets a new WebContents, so each attachment registers again under the same ID.
        const browserId = crypto.randomUUID();
        listen("did-attach", () => { if (live()) registerShortcuts(guest!, browserId, options.workspaceId); });
        // Paseo marks a pane focused on a bubbling `focusin`; focusing a guest doesn't produce one, so focus mode
        // and pane commands would act on the previously focused pane. Paseo's browser tabs mark their pane themselves.
        const markPaneFocused = () => { if (live()) guest!.dispatchEvent?.(new Event("focusin", { bubbles: true })); };
        listen("focus", markPaneFocused);
        listen("mousedown", markPaneFocused);
        listen("destroyed", fail);
        guest.setAttribute("partition", "persist:paseo-browser");
        Object.assign(guest.style, { width: "100%", height: "100%", display: "flex", flex: "1" });
        guest.setAttribute("src", url.href);
        clearTimeout(timer);
        timer = setTimeout(fail, options.loadTimeoutMs ?? (sharedOrigin ? 120_000 : 5_000));
        (container as Container).appendChild(guest);
        stopVisibility = observePaneVisibility(container, value => { visible = value; sendHostState(); });
        stopState = subscribeState(sendHostState);
      } catch { fail(); }
    };
    if (cached) attach(cached);
    else {
      // Separate requests for concurrent mounts: sharing a one-use ticket races its exchange.
      void Promise.resolve().then(() => live() ? options.launch() : undefined).then(launch => {
        if (!live() || !launch) return;
        if (!Number.isFinite(launch.expiresAt) || launch.expiresAt <= Date.now()) { fail(); return; }
        if (launch.sharedOrigin) {
          const origin = new URL(launch.sharedOrigin);
          if (origin.protocol !== "https:" || origin.origin !== launch.sharedOrigin) { fail(); return; }
          sharedOrigin = origin.origin;
        }
        attach(launch.url);
      }).catch(fail);
    }
  }

  if (options.fresh) sessions.delete(options.cacheKey);
  begin(options.fresh ? undefined : sessions.get(options.cacheKey) ?? options.saved);
  return dispose;
}
