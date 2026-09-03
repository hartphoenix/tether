export type SaveState = "loading" | "saved" | "dirty" | "saving" | "conflict" | "error";

export interface ChromeControlsOptions {
  saveIndicator: HTMLElement;
  notice: HTMLElement;
  zoomButton: HTMLButtonElement;
  zoomMenu: HTMLElement;
  zoomSlider: HTMLInputElement;
  zoomLabel: HTMLElement;
  onZoomChange: (scale: number) => void;
}

export interface ChromeControls {
  setSaveState(state: SaveState): void;
  setNotice(message: string, timeout?: number): void;
  setZoom(scale: number): void;
  getZoom(): number;
  destroy(): void;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_NOTICE_TIMEOUT = 4_000;
const MIN_ZOOM = 75;
const MAX_ZOOM = 175;
const DEFAULT_ZOOM = 100;

const SAVE_STATE_LABELS: Record<SaveState, string> = {
  loading: "Loading",
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving",
  conflict: "Conflict",
  error: "Error",
};

function createSaveIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("wm-save-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const outline = document.createElementNS(SVG_NAMESPACE, "path");
  outline.setAttribute("d", "M4 3.5h12.5L20 7v13.5H4z");
  svg.append(outline);

  const label = document.createElementNS(SVG_NAMESPACE, "path");
  label.setAttribute("d", "M8 3.5v6h8v-6");
  svg.append(label);

  const disk = document.createElementNS(SVG_NAMESPACE, "rect");
  disk.setAttribute("x", "7.5");
  disk.setAttribute("y", "13.5");
  disk.setAttribute("width", "9");
  disk.setAttribute("height", "7");
  disk.setAttribute("rx", "1");
  svg.append(disk);

  return svg;
}

function clampZoom(scale: number, fallback: number): number {
  if (!Number.isFinite(scale)) return fallback;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function createChromeControls(options: ChromeControlsOptions): ChromeControls {
  const {
    saveIndicator,
    notice,
    zoomButton,
    zoomMenu,
    zoomSlider,
    zoomLabel,
    onZoomChange,
  } = options;

  let saveState: SaveState = "loading";
  let zoom = DEFAULT_ZOOM;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  saveIndicator.classList.add("wm-save-indicator");
  saveIndicator.replaceChildren(createSaveIcon());
  if (!saveIndicator.hasAttribute("role") && saveIndicator.tagName !== "BUTTON") {
    saveIndicator.setAttribute("role", "img");
  }

  zoomButton.classList.add("wm-zoom-button");
  zoomMenu.classList.add("wm-zoom-menu");
  zoomSlider.classList.add("wm-zoom-slider");
  zoomLabel.classList.add("wm-zoom-label");
  notice.classList.add("wm-notice");

  function renderSaveState(): void {
    const label = `Save status: ${SAVE_STATE_LABELS[saveState]}`;
    saveIndicator.dataset.saveState = saveState;
    saveIndicator.setAttribute("aria-label", label);
    saveIndicator.setAttribute("title", label);
  }

  function renderZoom(): void {
    const zoomText = `${zoom}%`;
    zoomLabel.textContent = zoomText;
    zoomLabel.setAttribute("aria-label", `Zoom: ${zoomText}`);
    zoomLabel.setAttribute("title", `Zoom: ${zoomText}`);
    zoomSlider.value = String(zoom);
    zoomButton.title = `Zoom · ${zoomText}`;
    zoomButton.setAttribute("aria-label", zoomButton.title);
  }

  function setSaveState(nextState: SaveState): void {
    if (destroyed) return;
    saveState = nextState;
    renderSaveState();
  }

  function setNotice(message: string, timeout = DEFAULT_NOTICE_TIMEOUT): void {
    if (noticeTimer !== undefined) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
    if (destroyed) return;

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
  renderSaveState();
  renderZoom();

  return {
    setSaveState,
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
