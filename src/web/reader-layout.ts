/** One viewport policy, independent of where the file or service lives. */
export function mountReaderLayout(options: {
  controls: HTMLElement;
  comment: HTMLElement;
  theme: HTMLElement;
  extras?: HTMLElement[];
  closeFolio: () => void;
}) {
  const query = window.matchMedia("(max-width: 700px)");
  const commentHome = document.createComment("comment control");
  const themeHome = document.createComment("theme control");
  options.comment.before(commentHome);
  options.theme.before(themeHome);
  const extras = (options.extras ?? []).map(element => { const home = document.createComment("reader action"); element.before(home); return { element, home }; });
  const update = () => {
    const compact = query.matches;
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
  update();
  return () => { query.removeEventListener("change", update); };
}
