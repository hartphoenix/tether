import type { EditorView } from "@milkdown/kit/prose/view";
import { identityColor, identityIcon, identityName, type IdentityLookup } from "./identities";
import { iconSvg } from "./icons";
import type { ContextMenuEntry } from "./selection-ui";
import { createDoubleSecondaryTap, hunkAtPoint, markHunkSeen, reviewState, revertHunk, showsBefore, toggleHunks, type Hunk } from "./incoming-diff";

/**
 * Pointer handling for changes under review. A right-click on a hunk opens its
 * menu. A second secondary click or two-finger tap close to the first, within
 * the double-click interval, toggles the hunk between its current and earlier
 * wording instead. On a Mac trackpad a two-finger tap is a secondary click, so
 * a two-finger double tap arrives as that pair.
 */
export function createChangeReviewMenu(options: {
  identity?: IdentityLookup;
  getView: () => EditorView | null;
  closeMenus: () => void;
  onComment: (view: EditorView, hunk: Hunk) => void;
}) {
  const paired = createDoubleSecondaryTap();
  let lastHunk: Hunk | undefined;

  const toggleAt = (x: number, y: number, target: EventTarget | null, time: number): boolean => {
    const view = options.getView();
    if (!view || !reviewState(view)) { paired(x, y, time); lastHunk = undefined; return false; }
    // The second tap can land on the menu the first one opened, so fall back to that hunk.
    const hunk = hunkAtPoint(view, x, y, target) ?? lastHunk;
    if (!paired(x, y, time)) { lastHunk = hunk; return false; }
    lastHunk = undefined;
    if (!hunk) return false;
    options.closeMenus();
    toggleHunks(view, [hunk]);
    return true;
  };

  const onContextMenu = (event: MouseEvent) => {
    if (toggleAt(event.clientX, event.clientY, event.target, event.timeStamp)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    const [a, b] = [event.touches[0]!, event.touches[1]!];
    const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2;
    if (toggleAt(x, y, document.elementFromPoint(x, y), event.timeStamp)) event.preventDefault();
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });

  return {
    /** Menu items for a right-click on a hunk; null elsewhere. */
    items(view: EditorView, event: MouseEvent): ContextMenuEntry[] | null {
      const state = reviewState(view);
      const hunk = state ? hunkAtPoint(view, event.clientX, event.clientY, event.target) : undefined;
      if (!state || !hunk) return null;
      const before = showsBefore(state, hunk);
      const authors = new Set((state.authors ?? []).filter(span =>
        span.from < hunk.toB && span.to > hunk.fromB
      ).map(span => span.authorId));
      if (!authors.size) authors.add(null);
      const headings: ContextMenuEntry[] = [...authors].map(id => {
        const identity = id ? options.identity?.(id) : undefined;
        const badge = identityIcon(identity);
        const color = identityColor(identity);
        if (badge && color) badge.style.setProperty("--wm-agent-color", color);
        return { kind: "attribution", label: id ? identityName(options.identity, id) : "Author unknown", badge };
      });
      return [
        ...headings,
        { label: "Comment", icon: iconSvg("message-square"), run: () => options.onComment(view, hunk) },
        { label: before ? "Show current wording" : "Show earlier wording", icon: iconSvg("arrow-down-up"), run: () => toggleHunks(view, [hunk]) },
        { label: "Mark seen", icon: iconSvg("square-check"), run: () => markHunkSeen(view, hunk) },
        { label: "Revert this change", icon: iconSvg("rotate-cw"), run: () => revertHunk(view, hunk) },
      ];
    },
    destroy() {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
    },
  };
}
