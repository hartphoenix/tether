import { pendingAgentSkillReviews } from "../cli/agent-skills";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { TetherConfig } from "./config";
import { discoverVerifiedRelease } from "../releases/verified-update";
export { newerVersion } from "../releases/verified-update";

const interval = 6 * 60 * 60 * 1000;
const prolonged = 24 * 60 * 60 * 1000;
export type AvailableUpdate = { version: string; tag: string; notes: string };
type UpdateState = { dismissed?: string | null; failed?: boolean; lastAttempt?: number; lastSuccess?: number; failureSince?: number | null };
export type UpdateStatus = { agentSkillReviewNeeded: boolean; managed: boolean; available: AvailableUpdate | null; installing: boolean; failed: boolean; lastAttempt?: number; lastSuccess?: number; checkFailed: boolean; prolongedFailure: boolean };
const writes = new Map<string, Promise<void>>();
async function state(config: TetherConfig): Promise<UpdateState> {
  try { return JSON.parse(await readFile(join(config.configDir, "updates.json"), "utf8")) ?? {}; }
  catch { return {}; }
}
/** Merge fields so supervisor outcomes preserve check history. */
export async function writeUpdateState(config: TetherConfig, patch: UpdateState): Promise<void> {
  const path = join(config.configDir, "updates.json");
  const next = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...await state(config), ...patch }), { mode: 0o600 });
    await rename(temporary, path);
  });
  writes.set(path, next);
  try { await next; } finally { if (writes.get(path) === next) writes.delete(path); }
}

/** One authenticated check per daemon, shared by reader and Folio views. */
export class UpdateService {
  private checkedAt = -Infinity;
  private pending?: Promise<void>;
  private available: AvailableUpdate | null = null;
  private installing = false;
  constructor(private options: {
    config: TetherConfig;
    root?: string;
    install?: (tag: string) => Promise<void>;
    discover?: typeof discoverVerifiedRelease;
    now?: () => number;
    architecture?: string;
  }) {}

  private async check(force = false): Promise<void> {
    if (!this.options.root) return;
    if (this.pending) return this.pending;
    const now = (this.options.now ?? Date.now)();
    if (now - this.checkedAt < (force ? 10_000 : interval)) return;
    this.checkedAt = now;
    this.pending = (async () => {
      await writeUpdateState(this.options.config, { lastAttempt: now });
      try {
        this.available = await (this.options.discover ?? discoverVerifiedRelease)(this.options.root!, this.options.architecture);
        await writeUpdateState(this.options.config, { lastSuccess: now, failureSince: null });
      } catch {
        // A previously advertised target must not stay installable after failed verification.
        this.available = null;
        const previous = await state(this.options.config);
        await writeUpdateState(this.options.config, { failureSince: previous.failureSince ?? now });
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async status(force = false): Promise<UpdateStatus> {
    await this.check(force);
    const saved = await state(this.options.config);
    return { agentSkillReviewNeeded: (await pendingAgentSkillReviews(this.options.config)).length > 0, managed: Boolean(this.options.root), available: saved.dismissed === this.available?.tag ? null : this.available, installing: this.installing, failed: saved.failed === true,
      lastAttempt: saved.lastAttempt, lastSuccess: saved.lastSuccess, checkFailed: saved.failureSince != null,
      prolongedFailure: saved.failureSince != null && (this.options.now ?? Date.now)() - saved.failureSince >= prolonged };
  }

  async dismiss(tag: unknown): Promise<void> {
    if (!this.available || tag !== this.available.tag || this.installing) throw new Error("Update changed. Check again.");
    await writeUpdateState(this.options.config, { dismissed: this.available.tag });
  }

  async install(tag: unknown): Promise<void> {
    if (this.installing) return;
    await this.check();
    if (!this.available || tag !== this.available.tag || !this.options.install) throw new Error("Update unavailable. Check again.");
    if (this.installing) return;
    this.installing = true;
    try {
      await writeUpdateState(this.options.config, { dismissed: null, failed: false });
      // The installed CLI refreshes metadata and verifies the archive again before execution.
      await this.options.install(this.available.tag);
    } catch (cause) { this.installing = false; await writeUpdateState(this.options.config, { failed: true }); throw cause; }
  }
}
