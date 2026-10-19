import { AGENT_COLOR_COUNT } from '../shared/agent-identity';

export { AGENT_COLOR_COUNT };

/** Theme variable for a registry-assigned color slot, `--tether-agent-1` through `--tether-agent-12`. */
export function agentColor(slot: number): string {
  return `var(--tether-agent-${slot})`;
}
