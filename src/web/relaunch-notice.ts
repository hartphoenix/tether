/** Self-contained so the standalone Folio page can embed the same renderer. */
export function renderRelaunchNotice(element: HTMLElement, message: string): boolean {
  if (element.dataset.relaunchNotice === "true") return true;
  const match = message.match(/Placement unavailable\. In cmux, run: `([^`]+)`/);
  if (!match) return false;
  element.dataset.relaunchNotice = "true";
  element.setAttribute("role", "alert");
  const code = element.ownerDocument.createElement("code");
  code.textContent = match[1]!;
  code.style.userSelect = "all";
  code.style.overflowWrap = "anywhere";
  element.replaceChildren("Placement unavailable. In cmux, run: ", code);
  return true;
}
