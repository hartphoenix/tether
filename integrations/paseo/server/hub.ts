import type { FolioEntry, HubStatus, Intent, Notice, PumpBatch } from "../shared/contracts";
import type { TetherRunner } from "./tether-cli";

/** One intent as `tether paseo wait` returns it. */
type TetherIntent = {
  id: string;
  seq: number;
  url: string;
  path?: string;
  kind: "document" | "recents";
  origin: "user" | "agent";
  target?: Record<string, string>;
  expiresAt: number;
};
type WaitBatch = { cursor: number; folio: number; intents: TetherIntent[]; instanceId: string };

/** The Paseo lookups the hub needs, supplied from a handler context. */
export type PaseoLookup = {
  terminalWorkspace(terminalId: string): Promise<string | null>;
  /** Workspaces with real paths of their checkout and project root, for matching Folio additions. */
  workspaces(): Promise<WorkspacePlace[]>;
};

export type WorkspacePlace = { id: string; directory: string | null; projectRoot: string };

export type HubOptions = {
  run: TetherRunner;
  now?: () => number;
  leaseMs?: number;
  pumpMs?: number;
  waitSeconds?: number;
  /** Opens by the user within this window never light a button. */
  seenMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether header-button notices are wanted; read on every pump. */
  buttons?: () => boolean;
};

type Held = { intent: Intent; leaseUntil: number; expiresAt: number };

function fileName(path: string): string {
  return path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? path;
}

function within(path: string, directory: string): boolean {
  const root = directory.endsWith("/") ? directory : `${directory}/`;
  return path.startsWith(root);
}

/**
 * The plugin's single piece of state. It pulls Tether's queue for the whole
 * installation, hands each user intent to exactly one client that can open
 * tabs (leased until acked), and turns agent announcements and new Folio
 * entries into per-workspace notices. Focus moves only on a user's action.
 */
export class Hub {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private revision = 0;
  private cursor = 0;
  private folioVersion = -1;
  private instanceId: string | null = null;
  private folio: FolioEntry[] | null = null;
  private watermark: number | null = null;
  private readonly held = new Map<string, Held>();
  private readonly notices = new Map<string, Notice>();
  private readonly seen = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private lookup: PaseoLookup | null = null;
  private status: HubStatus = { connected: false, tether: null, error: null };

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Remember how to reach Paseo; the handler context is the only source. */
  attach(lookup: PaseoLookup): void { this.lookup = lookup; }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.wake();
  }

  private changed(): void {
    this.revision += 1;
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private setStatus(next: HubStatus): void {
    if (next.connected === this.status.connected && next.error === this.status.error && next.tether === this.status.tether) return;
    this.status = next;
    this.changed();
  }

  private async loop(): Promise<void> {
    let backoff = 1_000;
    while (this.running) {
      try {
        await this.pullOnce();
        backoff = 1_000;
      } catch (cause) {
        // A Tether release older than the Paseo channel rejects `tether paseo` as unknown.
        const outdated = (cause as { code?: unknown }).code === "usage";
        const error = outdated ? "This Tether version doesn't support Paseo. Update Tether, or set a newer tether command in settings." : cause instanceof Error ? cause.message : String(cause);
        this.setStatus({ connected: false, tether: this.status.tether, error });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** One `tether paseo wait` round: absorb intents, then refresh Folio if it changed. */
  async pullOnce(): Promise<void> {
    const batch = await this.options.run(["paseo", "wait", "--after", String(this.cursor), "--folio", String(this.folioVersion), "--timeout", String(this.options.waitSeconds ?? 20)]) as WaitBatch;
    if (batch.instanceId !== this.instanceId) {
      // A restarted daemon numbers intents and Folio versions from scratch.
      this.instanceId = batch.instanceId;
      if (batch.cursor < this.cursor) this.cursor = 0;
    }
    const acknowledged: string[] = [];
    for (const intent of batch.intents) {
      this.cursor = Math.max(this.cursor, intent.seq);
      if (this.held.has(intent.id)) continue;
      if (intent.origin === "agent" || intent.kind !== "document") {
        acknowledged.push(intent.id);
        if (intent.origin === "agent" && intent.path) await this.announce(intent.path, await this.workspaceFor(intent.target), true);
        continue;
      }
      const workspaceId = await this.workspaceFor(intent.target);
      if (!workspaceId) { acknowledged.push(intent.id); continue; }
      if (intent.path) this.markSeen(intent.path);
      this.held.set(intent.id, { intent: { id: intent.id, url: intent.url, workspaceId }, leaseUntil: 0, expiresAt: intent.expiresAt });
      this.changed();
    }
    this.cursor = Math.max(this.cursor, batch.cursor);
    if (acknowledged.length) await this.options.run(["paseo", "ack", ...acknowledged]);
    if (batch.folio !== this.folioVersion) {
      this.folioVersion = batch.folio;
      await this.refreshFolio();
    }
    this.setStatus({ connected: true, tether: batch.instanceId, error: null });
  }

  private async workspaceFor(target?: Record<string, string>): Promise<string | null> {
    if (target?.workspaceId) return target.workspaceId;
    if (target?.terminalId && this.lookup) return this.lookup.terminalWorkspace(target.terminalId).catch(() => null);
    return null;
  }

  private markSeen(path: string): void {
    this.seen.set(path, this.now());
    for (const [workspaceId, notice] of this.notices) {
      if (notice.path === path) { this.notices.delete(workspaceId); this.changed(); }
    }
  }

  /** An agent's own announcement names its workspace, superseding any match by path. */
  private async announce(path: string, workspaceId: string | null, authoritative = false): Promise<void> {
    if (!workspaceId) return;
    if (authoritative) {
      for (const [other, notice] of this.notices) {
        if (other !== workspaceId && notice.path === path) { this.notices.delete(other); this.changed(); }
      }
    }
    const name = this.folio?.find(entry => entry.path === path)?.name ?? fileName(path);
    const current = this.notices.get(workspaceId);
    if (current?.path === path && current.name === name) return;
    this.notices.set(workspaceId, { path, name });
    this.changed();
  }

  private async refreshFolio(): Promise<void> {
    const data = await this.options.run(["folio", "list", "--view", "active", "--sort", "opened"]) as { files: Array<Record<string, unknown>> };
    const entries: FolioEntry[] = data.files.map(file => ({
      path: String(file.path),
      name: String(file.name ?? fileName(String(file.path))),
      directory: String(file.directory ?? ""),
      repository: typeof file.repository === "string" ? file.repository : null,
      pinned: file.pinned === true,
      missing: file.missing === true,
      attentionCount: typeof file.attentionCount === "number" ? file.attentionCount : 0,
      openedAt: typeof file.openedAt === "number" ? file.openedAt : 0,
    }));
    const newest = entries.reduce((max, entry) => Math.max(max, entry.openedAt), 0);
    this.folio = entries;
    if (this.watermark === null) this.watermark = newest; // Never announce what predates this session.
    else await this.announceAdditions(entries);
    this.watermark = Math.max(this.watermark, newest);
    this.changed();
  }

  /** Entries opened since the watermark, not by the user here, light their workspace's button. */
  private async announceAdditions(entries: FolioEntry[]): Promise<void> {
    const seenMs = this.options.seenMs ?? 120_000;
    const announced = new Set([...this.notices.values()].map(notice => notice.path));
    const fresh = entries.filter(entry => {
      if (entry.openedAt <= this.watermark! || announced.has(entry.path)) return false;
      const seenAt = this.seen.get(entry.path);
      return seenAt === undefined || entry.openedAt - seenAt > seenMs;
    });
    if (!fresh.length || !this.lookup) return;
    const workspaces = await this.lookup.workspaces().catch(() => []);
    for (const entry of [...fresh].sort((a, b) => a.openedAt - b.openedAt)) {
      const workspaceId = this.matchWorkspace(entry.path, workspaces);
      if (workspaceId) await this.announce(entry.path, workspaceId);
    }
  }

  /**
   * The workspace whose checkout most specifically contains the path; failing
   * that, the project root, but only when exactly one workspace shares it.
   */
  private matchWorkspace(path: string, workspaces: WorkspacePlace[]): string | null {
    let best: { id: string; length: number } | null = null;
    for (const workspace of workspaces) {
      const directory = workspace.directory;
      if (directory && within(path, directory) && (!best || directory.length > best.length)) best = { id: workspace.id, length: directory.length };
    }
    if (best) return best.id;
    const byRoot = workspaces.filter(workspace => within(path, workspace.projectRoot));
    return byRoot.length === 1 ? byRoot[0]!.id : null;
  }

  private nextChange(ms?: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { if (timer) clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = ms === undefined ? undefined : setTimeout(done, Math.max(ms, 1));
      this.waiters.add(done);
    });
  }

  /** Unleased intents whose launch ticket is still valid; expired ones are dropped. */
  private offerable(): Held[] {
    const current = this.now();
    for (const [id, held] of this.held) if (held.expiresAt <= current) this.held.delete(id);
    return [...this.held.values()].filter(held => held.leaseUntil <= current);
  }

  /** Long-poll for clients. Executors lease intents; others only read state. */
  async pump(revision: number, executor: boolean): Promise<PumpBatch> {
    let expired = false;
    const deadline = setTimeout(() => { expired = true; this.wake(); }, this.options.pumpMs ?? 25_000);
    try {
      while (this.running && !expired && this.revision <= revision && !(executor && this.offerable().length)) {
        // Wake early for a lease that lapses before the deadline.
        const lapses = executor ? [...this.held.values()].map(held => held.leaseUntil - this.now()).filter(ms => ms > 0) : [];
        await this.nextChange(lapses.length ? Math.min(...lapses) : undefined);
      }
    } finally { clearTimeout(deadline); }
    const leaseUntil = this.now() + (this.options.leaseMs ?? 10_000);
    const intents = executor ? this.offerable().map(held => { held.leaseUntil = leaseUntil; return held.intent; }) : [];
    return {
      revision: this.revision,
      intents,
      folio: this.folio,
      notices: this.options.buttons?.() === false ? {} : Object.fromEntries(this.notices),
      buttons: this.options.buttons?.() !== false,
      status: this.status,
    };
  }

  async ack(ids: string[]): Promise<number> {
    const done = ids.filter(id => this.held.delete(id));
    if (done.length) await this.options.run(["paseo", "ack", ...done]);
    return done.length;
  }

  /** Open a document for the user; the tab returns through `pump` as an intent. */
  async open(path: string, workspaceId: string): Promise<void> {
    this.markSeen(path);
    await this.options.run(["open", path, "--host", "paseo"], { TETHER_PASEO_WORKSPACE_ID: workspaceId, TETHER_PASEO_ORIGIN: "user" });
  }

  async pin(path: string, pinned: boolean): Promise<void> {
    await this.options.run(["folio", "pin", path, ...(pinned ? [] : ["--off"])]);
  }
}
