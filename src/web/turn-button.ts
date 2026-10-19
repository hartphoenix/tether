import { turnIcon, turnIcons } from './turn-icons';
import { identityColor, identityName, type IdentityLookup } from './identities';
import { bindAgentRename } from './agent-rename';

export type TurnAgent = { agentId: string; label?: string; state: 'ready' | 'working' };
export type TurnPress = { cursor: string; sequence: number; agentId: string };

type Slot = { item: HTMLElement; button: HTMLButtonElement; caption: HTMLElement; icon?: string; agent?: TurnAgent; pending: boolean };

/**
 * One Go button per agent waiting on this document, stacked from the drawer's
 * bottom-right corner. Each shows its agent's own icon and color. A press wakes
 * only that agent and carries no content.
 */
export function createTurnControls(options: {
  request: (agentId: string) => Promise<TurnPress>;
  notice: (message: string) => void;
  identity?: IdentityLookup;
  rename?: (agentId: string, x: number, y: number) => void;
}) {
  const root = document.createElement('div');
  root.className = 'wm-turn-stack';
  const slots = new Map<string, Slot>();
  let agents: readonly TurnAgent[] = [];

  const slot = (key: string): Slot => {
    let existing = slots.get(key);
    if (existing) return existing;
    const item = document.createElement('div');
    item.className = 'wm-turn-agent';
    const caption = document.createElement('span');
    caption.className = 'wm-turn-caption';
    caption.setAttribute('aria-hidden', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wm-turn-button';
    // An agent's button stays blank until its identity resolves; the empty placeholder shows the first icon.
    if (!key) button.innerHTML = turnIcons[0]!;
    item.append(caption, button);
    existing = { item, button, caption, pending: false };
    const current = existing;
    button.addEventListener('click', () => { void press(current); });
    if (key && options.rename) for (const target of [caption, button]) bindAgentRename(target, (x, y) => { if (current.agent) options.rename!(current.agent.agentId, x, y); });
    slots.set(key, existing);
    return existing;
  };

  const render = (entry: Slot) => {
    const { agent, button, item, caption } = entry;
    if (!agent) {
      item.dataset.state = 'none';
      button.disabled = true;
      button.title = 'No agent is waiting';
      button.setAttribute('aria-label', 'No agent is waiting');
      caption.textContent = '';
      return;
    }
    const identity = options.identity?.(agent.agentId);
    const name = identityName(options.identity, agent.agentId);
    const working = agent.state === 'working';
    item.dataset.state = agent.state;
    const color = identityColor(identity);
    if (color) item.style.setProperty('--wm-agent-color', color); else item.style.removeProperty('--wm-agent-color');
    if (identity?.icon && entry.icon !== identity.icon) { button.innerHTML = turnIcon(identity.icon); entry.icon = identity.icon; }
    button.disabled = working || entry.pending;
    const description = `${name}${agent.label ? `: ${agent.label}` : ''}`;
    button.title = working ? `${description} (taking its turn)` : `Take the next turn: ${description}`;
    button.setAttribute('aria-label', working ? `${name} is taking its turn` : `Take the next turn: ${name}`);
    caption.textContent = agent.label ?? name;
  };

  const press = async (entry: Slot) => {
    const agent = entry.agent;
    if (!agent || agent.state !== 'ready' || entry.pending) return;
    entry.pending = true;
    render(entry);
    try {
      await options.request(agent.agentId);
      entry.agent = { ...agent, state: 'working' };
      entry.item.classList.remove('is-sent');
      void entry.item.offsetWidth; // Restart the pulse.
      entry.item.classList.add('is-sent');
      setTimeout(() => entry.item.classList.remove('is-sent'), 700);
    } catch (error) {
      options.notice(`Could not send the turn: ${(error as Error).message}`);
    } finally {
      entry.pending = false;
      render(entry);
    }
  };

  const placeholder = slot('');
  render(placeholder);
  root.append(placeholder.item);
  root.dataset.count = '1';

  return {
    root,
    /** Replace the agent list with the daemon's current view. */
    update(next: readonly TurnAgent[]) {
      agents = next;
      const keys = new Set(next.map(agent => agent.agentId));
      for (const [key, entry] of slots) if (key && !keys.has(key)) { entry.item.remove(); slots.delete(key); }
      placeholder.item.hidden = next.length > 0;
      const order = [placeholder.item];
      for (const agent of next) {
        const entry = slot(agent.agentId);
        entry.agent = agent;
        render(entry);
        order.push(entry.item);
      }
      // Reorder only on change, so a focused button keeps focus across updates.
      if (order.some((item, index) => root.children[index] !== item) || root.children.length !== order.length) root.replaceChildren(...order);
      root.dataset.count = String(Math.max(1, next.length));
    },
    /** Redraw names, icons and colors after the identity registry changes. */
    refreshIdentities() { for (const agent of agents) { const entry = slots.get(agent.agentId); if (entry) render(entry); } },
  };
}
