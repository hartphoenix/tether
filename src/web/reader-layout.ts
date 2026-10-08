export type ReaderMode = "desktop" | "mobile";

export function mobileClient(client: { userAgent: string; userAgentData?: { mobile: boolean } }, touchFirst: boolean): boolean {
  return touchFirst || client.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(client.userAgent);
}

/** Browser-local preference; viewport width never selects the interface. */
export function mountReaderLayout(options: {
  controls: HTMLElement;
  comment: HTMLElement;
  theme: HTMLElement;
  extras?: HTMLElement[];
  closeFolio: () => void;
}) {
  const key = "tether.readerMode";
  const query = window.matchMedia("(pointer: coarse) and (hover: none)");
  const readPreference = (): ReaderMode | null => {
    try { const value = window.localStorage.getItem(key); return value === "desktop" || value === "mobile" ? value : null; }
    catch { return null; }
  };
  let preferred = readPreference();
  const mode = (): ReaderMode => preferred ?? (mobileClient(window.navigator, query.matches) ? "mobile" : "desktop");
  const commentHome = document.createComment("comment control");
  const themeHome = document.createComment("theme control");
  options.comment.before(commentHome);
  options.theme.before(themeHome);
  const extras = (options.extras ?? []).map(element => { const home = document.createComment("reader action"); element.before(home); return { element, home }; });
  const update = () => {
    const compact = mode() === "mobile";
    document.documentElement.toggleAttribute("data-phone-reader", compact);
    options.controls.hidden = !compact;
    options.controls.inert = !compact;
    for (const { element, home } of extras) { if (compact) options.controls.append(element); else home.after(element); }
    options.theme.classList.toggle("wm-phone-theme-picker", compact);
    if (compact) { options.controls.append(options.comment); document.body.append(options.theme); }
    else { commentHome.after(options.comment); themeHome.after(options.theme); options.closeFolio(); }
    for (const element of document.querySelectorAll<HTMLElement>("#phone-folio,#mobile-folio")) {
      element.hidden = !compact;
      if (!compact) element.inert = true;
      else if (element.id === "phone-folio") element.inert = false;
    }
  };
  query.addEventListener("change", update);
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { preferred = readPreference(); update(); } };
  window.addEventListener("storage", storage);
  update();
  return {
    mode,
    select(value: ReaderMode) { preferred = value; update(); window.localStorage.setItem(key, value); },
    destroy() { query.removeEventListener("change", update); window.removeEventListener("storage", storage); },
  };
}
