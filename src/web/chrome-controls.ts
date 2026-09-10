import { renderRelaunchNotice } from "./relaunch-notice";

export interface ChromeControlsOptions {
  notice: HTMLElement;
  zoomButton: HTMLButtonElement;
  zoomMenu: HTMLElement;
  zoomSlider: HTMLInputElement;
  zoomLabel: HTMLElement;
  onZoomChange: (scale: number) => void;
}

export interface ChromeControls {
  setNotice(message: string, timeout?: number): void;
  setZoom(scale: number): void;
  getZoom(): number;
  destroy(): void;
}

const DEFAULT_NOTICE_TIMEOUT = 4_000;
const MIN_ZOOM = 75;
const MAX_ZOOM = 175;
const DEFAULT_ZOOM = 100;

function clampZoom(scale: number, fallback: number): number {
  if (!Number.isFinite(scale)) return fallback;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function createChromeControls(options: ChromeControlsOptions): ChromeControls {
  const {
    notice,
    zoomButton,
    zoomMenu,
    zoomSlider,
    zoomLabel,
    onZoomChange,
  } = options;

  let zoom = DEFAULT_ZOOM;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  zoomButton.classList.add("wm-zoom-button");
  zoomMenu.classList.add("wm-zoom-menu");
  zoomSlider.classList.add("wm-zoom-slider");
  zoomLabel.classList.add("wm-zoom-label");
  notice.classList.add("wm-notice");

  function renderZoom(): void {
    const zoomText = `${zoom}%`;
    zoomLabel.textContent = zoomText;
    zoomLabel.setAttribute("aria-label", `Zoom: ${zoomText}`);
    zoomLabel.setAttribute("title", `Zoom: ${zoomText}`);
    zoomSlider.value = String(zoom);
    zoomButton.title = `Zoom · ${zoomText}`;
    zoomButton.setAttribute("aria-label", zoomButton.title);
  }

  function setNotice(message: string, timeout = DEFAULT_NOTICE_TIMEOUT): void {
    if (noticeTimer !== undefined) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
    if (destroyed) return;

    if (renderRelaunchNotice(notice, message)) return;

    notice.textContent = message;
    if (message && timeout > 0 && Number.isFinite(timeout)) {
      noticeTimer = setTimeout(() => {
        notice.textContent = "";
        noticeTimer = undefined;
      }, timeout);
    }
  }

  function setZoom(nextZoom: number): void {
    if (destroyed) return;
    const clampedZoom = clampZoom(nextZoom, zoom);
    if (clampedZoom === zoom) {
      renderZoom();
      return;
    }
    zoom = clampedZoom;
    renderZoom();
    onZoomChange(zoom);
  }

  const closeZoom = (): void => {
    zoomMenu.hidden = true;
    zoomButton.setAttribute("aria-expanded", "false");
  };
  const toggleZoom = (event: Event): void => {
    event.stopPropagation();
    const open = zoomMenu.hidden;
    zoomMenu.hidden = !open;
    zoomButton.setAttribute("aria-expanded", String(open));
    if (open) zoomSlider.focus();
  };
  const changeZoom = (): void => setZoom(Number(zoomSlider.value));
  const outsideZoom = (event: Event): void => {
    if (!(event.target instanceof Node) || (!zoomMenu.contains(event.target) && !zoomButton.contains(event.target))) closeZoom();
  };
  const escapeZoom = (event: KeyboardEvent): void => { if (event.key === "Escape") closeZoom(); };

  zoomButton.addEventListener("click", toggleZoom);
  zoomSlider.addEventListener("input", changeZoom);
  document.addEventListener("pointerdown", outsideZoom);
  document.addEventListener("keydown", escapeZoom);
  renderZoom();

  return {
    setNotice,
    setZoom,
    getZoom: () => zoom,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      zoomButton.removeEventListener("click", toggleZoom);
      zoomSlider.removeEventListener("input", changeZoom);
      document.removeEventListener("pointerdown", outsideZoom);
      document.removeEventListener("keydown", escapeZoom);
      if (noticeTimer !== undefined) {
        clearTimeout(noticeTimer);
        noticeTimer = undefined;
      }
    },
  };
}
