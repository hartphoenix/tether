export type CrepeTheme = "frame-dark" | "crepe-dark" | "nord-dark" | "frame" | "crepe" | "nord";

const themes: Array<{ value: CrepeTheme; label: string }> = [
  { value: "frame-dark", label: "Frame Dark" },
  { value: "crepe-dark", label: "Crepe Dark" },
  { value: "nord-dark", label: "Nord Dark" },
  { value: "frame", label: "Frame Light" },
  { value: "crepe", label: "Crepe Light" },
  { value: "nord", label: "Nord Light" },
];

function isTheme(value: string | null): value is CrepeTheme {
  return themes.some((theme) => theme.value === value);
}

export function createThemePicker(
  button: HTMLButtonElement,
  menu: HTMLElement,
  editorRoot: HTMLElement,
  options: { initialTheme?: CrepeTheme; onChange?: (theme: CrepeTheme) => void } = {},
): { destroy(): void } {
  let selected: CrepeTheme = isTheme(options.initialTheme ?? null) ? options.initialTheme! : "frame-dark";

  const close = (): void => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  const apply = (theme: CrepeTheme, persist: boolean): void => {
    selected = theme;
    editorRoot.dataset.wmTheme = theme;
    document.documentElement.dataset.wmTheme = theme;
    const label = themes.find((candidate) => candidate.value === theme)!.label;
    button.title = `Theme · ${label}`;
    button.setAttribute("aria-label", button.title);
    menu.querySelectorAll<HTMLButtonElement>("button[data-theme]").forEach((option) => {
      option.classList.toggle("is-active", option.dataset.theme === theme);
      option.setAttribute("aria-checked", String(option.dataset.theme === theme));
    });
    if (persist) options.onChange?.(theme);
  };

  menu.replaceChildren(...themes.map(({ value, label }) => {
    const option = document.createElement("button");
    option.type = "button";
    option.dataset.theme = value;
    option.setAttribute("role", "menuitemradio");
    option.textContent = label;
    option.addEventListener("click", () => { apply(value, true); close(); });
    return option;
  }));
  menu.setAttribute("role", "menu");

  const toggle = (event: Event): void => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const outside = (event: Event): void => {
    if (!(event.target instanceof Node) || (!menu.contains(event.target) && !button.contains(event.target))) close();
  };
  const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
  button.addEventListener("click", toggle);
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
  apply(selected, false);

  return {
    destroy() {
      button.removeEventListener("click", toggle);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    },
  };
}
