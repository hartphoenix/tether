/**
 * Agent identity contract shared by the daemon and the reader. An agent signs
 * its work with an immutable ID; its display name, icon and color come from the
 * daemon's identity registry.
 */
export type IdentityKind = "agent" | "human";
export type Identity = { id: string; name: string; icon: string | null; colorSlot: number | null; kind: IdentityKind };

/** Hart's own identity: never registered, never colored. */
export const HUMAN_ID = "human";
/** Number of theme-able agent colors, `--tether-agent-1` through `--tether-agent-12`. */
export const AGENT_COLOR_COUNT = 12;
/** An agent is active, holding its name and icon, this long after it was last seen. */
export const ACTIVE_AGENT_MS = 24 * 60 * 60_000;
export const MAX_AGENT_NAME_LENGTH = 80;
export const MAX_AGENT_ID_LENGTH = 200;

/** Go icon names, in the order of `turnIcons` in src/web/turn-icons.ts. */
export const AGENT_ICON_NAMES = [
  "balloon", "blender", "cake-slice", "chef-hat", "chess-rook", "flame", "line-squiggle", "mirror-round",
  "notebook-pen", "paper-bag", "pickaxe", "ticket-check", "volleyball", "bowling", "catapult", "curling-stone",
  "dominoes-3", "glyph-curl", "glyph-infinity", "glyph-meander", "glyph-s", "newtons-cradle-left", "newtons-cradle",
  "pulse-ball", "spinning-top-tilt", "tetherball-whoosh", "wave-nodes", "winged-heel",
] as const;

export const isHumanId = (id: string) => id.trim().toLocaleLowerCase() === HUMAN_ID;
export const nameKey = (name: string) => name.trim().normalize("NFC").toLocaleLowerCase();
