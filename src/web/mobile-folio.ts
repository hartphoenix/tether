import { iconSvg } from "./icons";
import type { RemoteFolioEntry } from "../remote/contracts";

/** Phone navigation uses opaque document IDs; file locations remain with the adapter. */
export function mountMobileFolio(options: { list: () => Promise<RemoteFolioEntry[]>; beforeOpen: () => void }) {
  const trigger = document.createElement("button");
  trigger.id = "phone-folio"; trigger.type = "button"; trigger.className = "wm-phone-folio-button";
  trigger.innerHTML = iconSvg("folder-open"); trigger.setAttribute("aria-label", "Open Folio");
  trigger.setAttribute("aria-expanded", "false"); trigger.setAttribute("aria-controls", "mobile-folio");
  const drawer = document.createElement("aside");
  drawer.id = "mobile-folio"; drawer.className = "wm-mobile-folio"; drawer.inert = true;
  drawer.setAttribute("aria-label", "Folio");
  drawer.innerHTML = `<header class="wm-folio-toolbar">
    <nav class="wm-folio-tabs" aria-label="Folio view"><button type="button" data-view="active" aria-label="Active" title="Active" aria-pressed="true">${iconSvg("pulse")}<span class="wm-folio-count"></span></button><button type="button" data-view="archive" aria-label="Archive" title="Archive" aria-pressed="false">${iconSvg("archive")}</button></nav>
    <div class="wm-folio-actions"><button type="button" class="wm-folio-filter-toggle" aria-label="Hide filters" aria-controls="mobile-folio-filters" aria-expanded="true" aria-pressed="true">${iconSvg("funnel")}</button>
    <details><summary aria-label="View options" title="View options">${iconSvg("sliders-horizontal")}</summary><div class="wm-folio-popover"><label>Sort by<select aria-label="Sort documents"><option value="opened">Recently opened</option><option value="activity">Conversation activity</option><option value="modified">Last modified</option><option value="name">Name</option></select></label><button type="button" class="wm-folio-threads" aria-pressed="false">${iconSvg("chat")}Open threads</button></div></details>
    <details><summary aria-label="Folio menu" title="Folio menu">${iconSvg("list")}</summary><div class="wm-folio-popover"><button type="button" class="wm-folio-refresh">Refresh Folio</button><button type="button" class="wm-folio-close">Close Folio</button></div></details></div></header>
    <section id="mobile-folio-filters" aria-label="Filters"><form class="wm-folio-filter-entry"><input type="search" aria-label="Filter documents" placeholder="filter"><button type="submit" aria-label="Save filter" title="Save filter">${iconSvg("plus")}</button><button type="button" class="wm-folio-clear" aria-label="Clear filter">${iconSvg("x")}</button></form><div class="wm-folio-filter-bank" aria-label="Saved filters"></div></section>
    <p role="status"></p><div class="wm-folio-files"></div>`;
  document.body.append(trigger, drawer);
  const filter = drawer.querySelector("input")!, sort = drawer.querySelector("select")!;
  const bank = drawer.querySelector<HTMLElement>(".wm-folio-filter-bank")!;
  const filterToggle = drawer.querySelector<HTMLButtonElement>(".wm-folio-filter-toggle")!;
  const threads = drawer.querySelector<HTMLButtonElement>(".wm-folio-threads")!;
  const storageKey = "tether.mobile-folio.v1";
  let savedFilters: { text: string; active: boolean }[] = [], filtersVisible = true;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved) {
      if (Array.isArray(saved.filters)) savedFilters = saved.filters.filter((item: any) => typeof item?.text === "string" && typeof item.active === "boolean");
      if (typeof saved.query === "string") filter.value = saved.query;
      if (["opened", "activity", "modified", "name"].includes(saved.sort)) sort.value = saved.sort;
      filtersVisible = saved.filtersVisible !== false;
      threads.setAttribute("aria-pressed", String(saved.threads === true));
    }
  } catch { /* Keep navigation available without browser storage. */ }
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ filters: savedFilters, query: filter.value, sort: sort.value, filtersVisible, threads: threads.getAttribute("aria-pressed") === "true" })); }
    catch { status.textContent = "Filters cannot be saved in this browser."; }
  };
  const updateControls = () => {
    drawer.querySelector<HTMLElement>("#mobile-folio-filters")!.hidden = !filtersVisible;
    filterToggle.setAttribute("aria-expanded", String(filtersVisible));
    filterToggle.setAttribute("aria-pressed", String(filtersVisible));
    filterToggle.setAttribute("aria-label", filtersVisible ? "Hide filters" : "Show filters");
    drawer.querySelector<HTMLButtonElement>('[aria-label="Save filter"]')!.hidden = !filter.value.trim();
    drawer.querySelector<HTMLButtonElement>(".wm-folio-clear")!.hidden = !filter.value;
  };
  const renderFilters = () => {
    const scroll = bank.scrollLeft;
    bank.replaceChildren();
    for (const item of [...savedFilters].sort((a, b) => Number(b.active) - Number(a.active) || a.text.localeCompare(b.text))) {
      const pill = document.createElement("span"); pill.className = "wm-folio-filter-pill";
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.textContent = item.text; toggle.setAttribute("aria-pressed", String(item.active));
      toggle.onclick = () => { item.active = !item.active; renderFilters(); render(); persist(); [...bank.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(button => button.textContent === item.text)?.focus({ preventScroll: true }); };
      const remove = document.createElement("button"); remove.type = "button"; remove.innerHTML = iconSvg("x"); remove.setAttribute("aria-label", `Delete filter ${item.text}`);
      remove.onclick = () => { savedFilters = savedFilters.filter(saved => saved !== item); renderFilters(); render(); persist(); filter.focus(); };
      pill.append(toggle, remove); bank.append(pill);
    }
    bank.scrollLeft = scroll;
  };
  const status = drawer.querySelector<HTMLElement>('[role="status"]')!, list = drawer.querySelector<HTMLElement>(".wm-folio-files")!;
  let files: RemoteFolioEntry[] = [], view = "active", generation = 0, navigating = false;
  const close = (focus = true) => {
    generation++; drawer.querySelectorAll("details").forEach(menu => menu.open = false);
    drawer.classList.remove("is-open"); drawer.inert = true;
    trigger.setAttribute("aria-expanded", "false"); if (focus) trigger.focus({ preventScroll: true });
  };
  const render = () => {
    updateControls();
    drawer.querySelector(".wm-folio-count")!.textContent = String(files.filter(file => (file.view ?? "active") === "active").length);
    const queries = [filter.value, ...savedFilters.filter(item => item.active).map(item => item.text)].map(text => text.toLocaleLowerCase().trim()).filter(Boolean);
    const visible = files.filter(file => (file.view ?? "active") === view && queries.every(query => `${file.title} ${file.directory ?? ""}`.toLocaleLowerCase().includes(query)) && (threads.getAttribute("aria-pressed") !== "true" || !!file.attentionCount));
    visible.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (sort.value === "name" ? a.title.localeCompare(b.title) : (b[sort.value as "opened" | "modified" | "activity"] ?? 0) - (a[sort.value as "opened" | "modified" | "activity"] ?? 0)));
    list.replaceChildren(); status.textContent = visible.length ? "" : "No matching documents.";
    for (const file of visible) {
      const link = document.createElement("a"); link.className = "wm-folio-file";
      const readerRoot = location.pathname.slice(0, location.pathname.indexOf("/reader/") + "/reader/".length);
      link.href = `${readerRoot}d/${encodeURIComponent(file.id)}/`;
      const label = document.createElement("span"); label.className = "wm-folio-label";
      const title = document.createElement("span"); title.textContent = file.title; label.append(title);
      if (file.directory) { const directory = document.createElement("small"); directory.textContent = file.directory; label.append(directory); }
      if (file.pinned) { const pin = document.createElement("span"); pin.innerHTML = iconSvg("map-pin-simple"); pin.setAttribute("aria-label", "Pinned"); link.append(pin); }
      link.append(label);
      if (file.attentionCount) { const badge = document.createElement("span"); badge.className = "wm-folio-attention"; badge.textContent = String(file.attentionCount); badge.setAttribute("aria-label", `${file.attentionCount} open conversations`); link.append(badge); }
      if (file.unavailable) { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); title.textContent += " · Unavailable"; }
      link.onclick = event => {
        event.preventDefault(); if (file.unavailable || navigating) return;
        navigating = true; close(false);
        window.setTimeout(() => location.assign(link.href), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
      };
      list.append(link);
    }
  };
  const refresh = async () => {
    const current = ++generation;
    status.textContent = "Loading…"; list.replaceChildren();
    try { const result = await options.list(); if (generation !== current) return; files = result; render(); }
    catch { if (generation === current) status.textContent = "Could not load Folio. Close and reopen to retry."; }
  };
  trigger.onclick = () => {
    if (drawer.classList.contains("is-open")) { close(); return; }
    options.beforeOpen(); drawer.inert = false; drawer.classList.add("is-open"); trigger.setAttribute("aria-expanded", "true");
    drawer.querySelector<HTMLButtonElement>("[data-view]")!.focus({ preventScroll: true }); void refresh();
  };
  const closeMenus = () => drawer.querySelectorAll("details").forEach(menu => menu.open = false);
  drawer.querySelector<HTMLButtonElement>(".wm-folio-close")!.onclick = () => { closeMenus(); close(); };
  drawer.querySelector<HTMLButtonElement>(".wm-folio-refresh")!.onclick = () => { closeMenus(); void refresh(); };
  drawer.querySelectorAll("summary").forEach(summary => summary.onclick = () => {
    drawer.querySelectorAll("details").forEach(menu => { if (menu !== summary.parentElement) menu.open = false; });
  });
  drawer.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.onclick = () => {
    view = button.dataset.view!; drawer.querySelectorAll("[data-view]").forEach(tab => tab.setAttribute("aria-pressed", String(tab === button))); render();
  });
  filterToggle.onclick = () => { filtersVisible = !filtersVisible; updateControls(); persist(); };
  filter.oninput = () => { render(); persist(); };
  sort.onchange = () => { render(); persist(); };
  threads.onclick = () => { threads.setAttribute("aria-pressed", String(threads.getAttribute("aria-pressed") !== "true")); render(); persist(); };
  drawer.querySelector("form")!.onsubmit = event => {
    event.preventDefault(); const text = filter.value.trim(); if (!text) return;
    const existing = savedFilters.find(item => item.text.toLocaleLowerCase() === text.toLocaleLowerCase());
    if (existing) existing.active = true; else savedFilters.push({ text, active: true });
    filter.value = ""; renderFilters(); render(); persist(); filter.focus();
  };
  drawer.querySelector<HTMLButtonElement>(".wm-folio-clear")!.onclick = () => { filter.value = ""; render(); persist(); filter.focus(); };
  updateControls(); renderFilters();
  document.addEventListener("keydown", event => { if (event.key === "Escape" && drawer.classList.contains("is-open")) { event.preventDefault(); const openMenu = drawer.querySelector<HTMLDetailsElement>("details[open]"); if (openMenu) { openMenu.open = false; openMenu.querySelector("summary")!.focus(); } else close(); } });
  document.addEventListener("pointerdown", event => {
    if (!drawer.classList.contains("is-open")) return;
    if (!(event.target as Element).closest("#mobile-folio details")) closeMenus();
    if (!drawer.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(false);
  });
  return { close };
}
