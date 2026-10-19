/** Number of theme-able agent colors, `--tether-agent-1` through `--tether-agent-6`. */
export const AGENT_COLOR_COUNT = 6;

/** Stable 1-based palette slot for an actor name (FNV-1a over the normalized name). */
export function agentColorIndex(actor: string): number {
  let hash = 0x811c9dc5;
  for (const char of actor.trim().toLocaleLowerCase()) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return (hash % AGENT_COLOR_COUNT) + 1;
}

export function agentColor(actor: string): string {
  return `var(--tether-agent-${agentColorIndex(actor)})`;
}
