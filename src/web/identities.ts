import type { Identity } from '../shared/agent-identity';
import { agentColor } from './agent-colors';
import { turnIcon } from './turn-icons';

export type IdentityLookup = (id: string) => Identity | undefined;
type Fetch = (ids: readonly string[]) => Promise<{ identities: Identity[]; identityRevision: number }>;

/**
 * The reader's copy of the daemon's identity registry. It fetches IDs as they
 * appear and refetches everything it knows only when the registry's revision changes.
 */
export function createIdentityCache(options: { fetch: Fetch; changed: () => void }) {
  const known = new Map<string, Identity>();
  const wanted = new Set<string>();
  let revision: number | undefined;
  let inFlight: Promise<void> | undefined;
  let again = false;

  const load = async (ids: readonly string[]) => {
    const result = await options.fetch(ids);
    let changed = false;
    for (const identity of result.identities) {
      const prior = known.get(identity.id);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(identity)) { known.set(identity.id, identity); changed = true; }
    }
    revision = result.identityRevision;
    if (changed) options.changed();
  };

  const flush = () => {
    if (inFlight) { again = true; return; }
    const ids = [...wanted].slice(0, 200);
    if (!ids.length) return;
    for (const id of ids) wanted.delete(id);
    inFlight = load(ids).catch(() => { for (const id of ids) if (!known.has(id)) wanted.add(id); }).finally(() => {
      inFlight = undefined;
      if (again || wanted.size) { again = false; flush(); }
    });
  };

  return {
    get: ((id: string) => known.get(id)) as IdentityLookup,
    /** Ask for identities this reader hasn't resolved yet. */
    want(ids: Iterable<string>) {
      let added = false;
      for (const id of ids) if (id && !known.has(id) && !wanted.has(id)) { wanted.add(id); added = true; }
      if (added) flush();
    },
    /** A polled revision; a change means a rename or a new identity. */
    observe(next: number | undefined) {
      if (next === undefined || next === revision) return;
      if (revision === undefined && !known.size) { revision = next; return; }
      for (const id of known.keys()) wanted.add(id);
      revision = next;
      flush();
    },
    /** Apply an identity the daemon returned directly, such as after a rename. */
    set(identity: Identity, nextRevision?: number) {
      known.set(identity.id, identity);
      if (nextRevision !== undefined) revision = nextRevision;
      options.changed();
    },
  };
}

/** Name for an author ID: its current registry name, else the ID itself. */
export function identityName(lookup: IdentityLookup | undefined, id: string): string {
  return lookup?.(id)?.name ?? id;
}

/** Small icon element for an agent, colored by its slot; null for the human or an unresolved ID. */
export function identityIcon(identity: Identity | undefined): HTMLElement | null {
  if (!identity || identity.kind !== 'agent' || !identity.icon) return null;
  const span = document.createElement('span');
  span.className = 'wm-agent-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = turnIcon(identity.icon);
  return span;
}

/** Color for an agent identity; undefined for the human or an unresolved ID. */
export function identityColor(identity: Identity | undefined): string | undefined {
  return identity?.kind === 'agent' && identity.colorSlot ? agentColor(identity.colorSlot) : undefined;
}
