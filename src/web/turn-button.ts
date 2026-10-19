import { agentColor } from './agent-colors';
import { turnIcons } from './turn-icons';

export type TurnAgent = { actor: string; label?: string; state: 'ready' | 'working' };
export type TurnPress = { cursor: string; sequence: number; actor: string };

/** Shuffled bag (Fisher-Yates) that never shows the same face twice in a row, even across refills. */
export function createIconBag<T>(items: readonly T[], random: () => number = Math.random): () => T {
  let bag: T[] = [];
  let last: T | undefined;
  return () => {
    if (!bag.length) {
      bag = [...items];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j]!, bag[i]!];
      }
      // The bag is consumed from the end; keep the refill from repeating the last face.
      if (bag.length > 1 && bag.at(-1) === last) [bag[0], bag[bag.length - 1]] = [bag.at(-1)!, bag[0]!];
    }
    return last = bag.pop()!;
  };
}

type Slot = { item: HTMLElement; button: HTMLButtonElement; caption: HTMLElement; nextIcon: () => string; agent?: TurnAgent; pending: boolean };

/**
 * One Go button per agent waiting on this document, stacked from the drawer's
 * bottom-right corner. A press wakes only that agent and carries no content.
 */
export function createTurnControls(options: { request: (actor: string) => Promise<TurnPress>; notice: (message: string) => void; icons?: readonly string[] }) {
  const icons = options.icons ?? turnIcons;
  const root = document.createElement('div');
  root.className = 'wm-turn-stack';
  const slots = new Map<string, Slot>();

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
    const nextIcon = createIconBag(icons);
    button.innerHTML = nextIcon();
    item.append(caption, button);
    existing = { item, button, caption, nextIcon, pending: false };
    const current = existing;
    button.addEventListener('click', () => { void press(current); });
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
    const working = agent.state === 'working';
    item.dataset.state = agent.state;
    item.style.setProperty('--wm-agent-color', agentColor(agent.actor));
    button.disabled = working || entry.pending;
    const description = `${agent.actor}${agent.label ? `: ${agent.label}` : ''}`;
    button.title = working ? `${description} (taking its turn)` : `Take the next turn: ${description}`;
    button.setAttribute('aria-label', working ? `${agent.actor} is taking its turn` : `Take the next turn: ${agent.actor}`);
    caption.textContent = agent.label ?? agent.actor;
  };

  const press = async (entry: Slot) => {
    const agent = entry.agent;
    if (!agent || agent.state !== 'ready' || entry.pending) return;
    entry.pending = true;
    render(entry);
    try {
      await options.request(agent.actor);
      entry.agent = { ...agent, state: 'working' };
      entry.button.innerHTML = entry.nextIcon();
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
    update(agents: readonly TurnAgent[]) {
      const keys = new Set(agents.map(agent => agent.actor.trim().toLocaleLowerCase()));
      for (const [key, entry] of slots) if (key && !keys.has(key)) { entry.item.remove(); slots.delete(key); }
      placeholder.item.hidden = agents.length > 0;
      const order = [placeholder.item];
      for (const agent of agents) {
        const entry = slot(agent.actor.trim().toLocaleLowerCase());
        entry.agent = agent;
        render(entry);
        order.push(entry.item);
      }
      // Reorder only on change, so a focused button keeps focus across updates.
      if (order.some((item, index) => root.children[index] !== item) || root.children.length !== order.length) root.replaceChildren(...order);
      root.dataset.count = String(Math.max(1, agents.length));
    },
  };
}
