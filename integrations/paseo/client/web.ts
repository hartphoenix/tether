import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: { paseoDesktop?: unknown } | undefined;

/**
 * Whether this client is Paseo desktop, the only client whose panels can open
 * browser tabs. Mirrors the app's own check for its desktop bridge. A mounted
 * Folio panel with `openBrowser` also proves it, so this only matters before one mounts.
 */
export function isDesktop(): boolean {
  return Platform.OS === "web" && typeof window !== "undefined" && typeof window.paseoDesktop === "object" && window.paseoDesktop !== null;
}
