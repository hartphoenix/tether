/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { transcriptSelector } from "./dom";
import { parseSubmitted, type SubmittedPart } from "./submitted";

const sourceSelector = `${transcriptSelector} [data-testid="user-message"] [data-message-text="true"]:not([data-tether-submitted])`;
const sourceAttribute = "data-tether-submitted-source";
const css = `
[data-tether-submitted-source] { display:none !important; }
[data-tether-submitted] { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; min-width:0; }
[data-tether-submitted] p { margin:0; }
[data-tether-submitted] > :not(:first-child) { margin-top:12px; }
[data-tether-submitted] blockquote { margin:0; padding:0 0 0 10px; border-left:2px solid var(--colors-accent); }
[data-tether-submitted] .tether-submitted-speaker { color:var(--colors-foreground-muted); font-size:.8em; margin-bottom:3px; }
[data-tether-submitted] .tether-submitted-feedback { margin-top:6px; }
[data-tether-submitted] pre { margin:0; font:inherit; font-family:ui-monospace,monospace; white-space:pre-wrap; }
`;

function content(parts: SubmittedPart[]): HTMLElement {
  const body = document.createElement("div");
  body.dataset.tetherSubmitted = "true";
  body.dataset.messageText = "true"; // Keep visible text available to native find-in-chat.
  for (const part of parts) {
    if (part.kind === "prose") {
      // Separators become spacing between blocks; prose itself remains native plain text.
      const text = part.text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
      if (text) { const p = document.createElement("p"); p.textContent = text; body.append(p); }
      continue;
    }
    const section = document.createElement("section"), quote = document.createElement("blockquote"), speaker = document.createElement("div");
    speaker.className = "tether-submitted-speaker";
    speaker.textContent = part.draft.code ? "Code" : part.draft.from === "assistant" ? "Assistant" : part.draft.from === "user" ? "You" : "Selected passage";
    const passage = document.createElement(part.draft.code ? "pre" : "p");
    passage.textContent = part.draft.quote;
    if (part.draft.code) {
      passage.dataset.pmono = ""; // Opt out of Paseo's app-wide UI font rule.
      passage.dataset.paseoMarkdownTag = "pre";
      if (typeof part.draft.code === "string") passage.dataset.paseoMarkdownLanguage = part.draft.code;
    }
    quote.append(speaker, passage); section.append(quote);
    if (part.draft.feedback) {
      const feedback = document.createElement("p"); feedback.className = "tether-submitted-feedback";
      feedback.textContent = part.draft.feedback; section.append(feedback);
    }
    body.append(section);
  }
  return body;
}

/** Paseo 0.11.2's public renderer replaces attachments and actions too. Keep its
 * native row and React-owned text untouched; mount only a reversible text view. */
export function startSubmittedAnnotations() {
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);
  const entries = new Map<HTMLElement, { text: string; body: HTMLElement; aria: string | null }>();
  const restore = (source: HTMLElement) => {
    const entry = entries.get(source); if (!entry) return;
    entry.body.remove(); source.removeAttribute(sourceAttribute);
    if (entry.aria === null) source.removeAttribute("aria-hidden"); else source.setAttribute("aria-hidden", entry.aria);
    entries.delete(source);
  };
  function refresh() {
    for (const [source] of entries) if (!source.isConnected || !source.matches(sourceSelector)) restore(source);
    for (const source of document.querySelectorAll<HTMLElement>(sourceSelector)) {
      const text = source.textContent ?? "";
      let entry = entries.get(source);
      if (entry && entry.text !== text) { restore(source); entry = undefined; }
      if (!entry) {
        const parts = parseSubmitted(text); if (!parts) continue;
        entry = { text, body: content(parts), aria: source.getAttribute("aria-hidden") };
        entries.set(source, entry);
        source.setAttribute(sourceAttribute, ""); source.setAttribute("aria-hidden", "true");
      }
      if (source.nextSibling !== entry.body) source.after(entry.body);
      const native = getComputedStyle(source);
      // Native text owns its typography; keep it through theme/font changes.
      for (const property of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color"])
        entry.body.style.setProperty(property, native.getPropertyValue(property));
    }
  }
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  refresh();
  return { refresh, dispose() { observer.disconnect(); cancelAnimationFrame(frame); for (const [source] of entries) restore(source); style.remove(); } };
}
