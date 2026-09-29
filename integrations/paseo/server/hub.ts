import type { Connection, FolioEntry, HubStatus, Intent, Notice, PumpBatch } from "../shared/contracts";
import { folioViewSchema, type FolioView } from "../shared/contracts";
import type { TetherRunner } from "./tether-cli";

/** One intent as `tether paseo wait` returns it. */
type TetherIntent = {
  id: string;
  seq: number;
  url?: string;
  path?: string;
  kind: "document" | "recents";
  origin: "user" | "agent";
  target?: Record<string, string>;
  expiresAt: number;
};
type WaitBatch = { cursor: number; folio: number; intents: TetherIntent[]; instanceId: string };

/** The Paseo lookup the hub needs, supplied from a handler context. */
export type PaseoLookup = {
  terminalWorkspace(terminalId: string): Promise<string | null>;
};

export type HubOptions = {
  run: TetherRunner;
  connection?: Connection;
  now?: () => number;
  leaseMs?: number;
  pumpMs?: number;
  waitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether header-button notices are wanted; read on every pump. */
  buttons?: () => boolean;
};

type Held = { intent: Intent; leaseUntil: number; expiresAt: number; notices: Map<string, Announced> };
type Announced = { path: string; at: number };

function fileName(path: string): string {
  return path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? path;
}

/**
 * The plugin's single piece of state. It pulls Tether's queue for the whole
 * installation, hands each user intent to exactly one client that can open
 * tabs (leased until acked), and turns agents' announcements into
 * per-workspace notices. Focus moves only on a user's action.
 */
export class Hub {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopped = false;
  private revision = 0;
  private cursor = 0;
  private folioVersion = -1;
  private instanceId: string | null = null;
  private folio: FolioEntry[] | null = null;
  private readonly held = new Map<string, Held>();
  private readonly notices = new Map<string, Announced>();
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
    if (this.running || this.stopped) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.wake();
  }

  presentationChanged(): void { this.changed(); }

  private assertActive(): void {
    if (this.stopped) throw new Error("Tether connection changed. Retry from the current view.");
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
        if (this.stopped) break;
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
    this.assertActive();
    const batch = await this.options.run(["paseo", "wait", "--after", String(this.cursor), "--folio", String(this.folioVersion), "--timeout", String(this.options.waitSeconds ?? 20)]) as WaitBatch;
    this.assertActive();
    if (batch.instanceId !== this.instanceId) {
      // A restarted daemon numbers intents and Folio versions from scratch.
      this.instanceId = batch.instanceId;
      this.cursor = 0;
      this.folioVersion = -1;
      this.folio = null;
      this.held.clear();
      this.notices.clear();
      this.status = { connected: false, tether: batch.instanceId, error: null };
    }
    const acknowledged: string[] = [];
    for (const intent of batch.intents) {
      this.cursor = Math.max(this.cursor, intent.seq);
      if (this.held.has(intent.id)) continue;
      if (intent.origin === "agent" || intent.kind !== "document") {
        acknowledged.push(intent.id);
        if (intent.origin === "agent" && intent.path) {
          const workspace = await this.workspaceFor(intent.target);
          this.assertActive();
          this.announce(intent.path, workspace);
        }
        continue;
      }
      const workspaceId = await this.workspaceFor(intent.target);
      this.assertActive();
      if (!workspaceId || !intent.url) { acknowledged.push(intent.id); continue; }
      this.held.set(intent.id, { intent: { id: intent.id, url: intent.url, workspaceId }, leaseUntil: 0, expiresAt: intent.expiresAt,
        notices: new Map([...this.notices].filter(([, notice]) => notice.path === intent.path)),
      });
      this.changed();
    }
    this.cursor = Math.max(this.cursor, batch.cursor);
    for (let index = 0; index < acknowledged.length; index += 256) {
      await this.options.run(["paseo", "ack", ...acknowledged.slice(index, index + 256)]);
      this.assertActive();
    }
    if (batch.folio !== this.folioVersion) {
      await this.refreshFolio();
      this.assertActive();
      this.folioVersion = batch.folio;
    }
    this.setStatus({ connected: true, tether: batch.instanceId, error: null });
  }

  private async workspaceFor(target?: Record<string, string>): Promise<string | null> {
    if (target?.workspaceId) return target.workspaceId;
    if (target?.terminalId && this.lookup) return this.lookup.terminalWorkspace(target.terminalId).catch(() => null);
    return null;
  }

  /** Named from Folio when it knows the document, so the title stays current. */
  private notice(path: string): Notice {
    return { path, name: this.folio?.find(entry => entry.path === path)?.name ?? fileName(path) };
  }

  private announce(path: string, workspaceId: string | null): void {
    if (!workspaceId) return;
    this.notices.set(workspaceId, { path, at: this.now() });
    this.changed();
  }

  private async refreshFolio(): Promise<void> {
    const data = await this.options.run(["folio", "list", "--view", "active", "--sort", "opened"]) as { files: Array<Record<string, unknown>> };
    this.assertActive();
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
    this.folio = entries;
    // A notice lasts until its document is opened anywhere, which records a newer open.
    for (const [workspaceId, notice] of this.notices) {
      if ((entries.find(entry => entry.path === notice.path)?.openedAt ?? 0) > notice.at) this.notices.delete(workspaceId);
    }
    this.changed();
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
      connection: this.options.connection ?? null,
      revision: this.revision,
      intents,
      folio: this.folio,
      notices: this.options.buttons?.() === false ? {} : Object.fromEntries([...this.notices].map(([workspaceId, { path }]) => [workspaceId, this.notice(path)])),
      buttons: this.options.buttons?.() !== false,
      status: this.status,
    };
  }

  async ack(ids: string[]): Promise<number> {
    this.assertActive();
    const done = ids.filter(id => this.held.has(id));
    for (let index = 0; index < done.length; index += 256) {
      const chunk = done.slice(index, index + 256);
      await this.options.run(["paseo", "ack", ...chunk]);
      this.assertActive();
      for (const id of chunk) {
        const held = this.held.get(id);
        // The client opened the tab. Retire only announcements that this launch
        // consumed; a newer announcement, even for the same path, stays pending.
        for (const [workspaceId, notice] of held?.notices ?? []) {
          if (this.notices.get(workspaceId) === notice) {
            this.notices.delete(workspaceId);
            this.changed();
          }
        }
        this.held.delete(id);
      }
    }
    return done.length;
  }

  /** Open a document for the user; the tab returns through `pump` as an intent. */
  async open(path: string, workspaceId: string): Promise<void> {
    this.assertActive();
    await this.options.run(["open", path, "--host", "paseo"], { TETHER_PASEO_WORKSPACE_ID: workspaceId, TETHER_PASEO_ORIGIN: "user" });
  }

  async theme(clientId: string, theme: string | null): Promise<{ updated: boolean }> {
    this.assertActive();
    await this.options.run(["paseo", "theme", clientId, theme ?? "unknown"]);
    return { updated: true };
  }

  async pin(path: string, pinned: boolean): Promise<void> {
    this.assertActive();
    await this.options.run(["folio", "pin", path, ...(pinned ? [] : ["--off"])]);
  }

  /** Mint a one-use Folio launch for this client; never share tickets between clients. */
  async folioView(workspaceId: string): Promise<FolioView> {
    this.assertActive();
    return folioViewSchema.parse(await this.options.run(["folio", "--url", "--host", "paseo"], {
      TETHER_PASEO_WORKSPACE_ID: workspaceId, TETHER_PASEO_ORIGIN: "user",
    }));
  }
}
