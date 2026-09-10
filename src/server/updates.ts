import { readFile, writeFile, rename, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { TetherConfig } from "./config";

const repository = "https://github.com/hartphoenix/tether";
const interval = 6 * 60 * 60 * 1000;
export type AvailableUpdate = { version: string; tag: string; notes: string };
type UpdateState = { dismissed?: string; failed?: boolean };
export type UpdateStatus = { available: AvailableUpdate | null; installing: boolean; failed: boolean };

export function newerVersion(candidate: string, installed: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(installed)) return false;
  const a = candidate.split(".").map(BigInt), b = installed.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export async function writeUpdateState(config: TetherConfig, state: UpdateState): Promise<void> {
  const path = join(config.configDir, "updates.json"), temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

/** One check per daemon, shared by all Folio views. No document data leaves the machine. */
export class UpdateService {
  private checkedAt = -Infinity;
  private pending?: Promise<void>;
  private available: AvailableUpdate | null = null;
  private installing = false;
  constructor(private options: {
    config: TetherConfig;
    root?: string;
    install?: (tag: string) => Promise<void>;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
    architecture?: string;
  }) {}

  private async state(): Promise<UpdateState> {
    try { return JSON.parse(await readFile(join(this.options.config.configDir, "updates.json"), "utf8")) ?? {}; }
    catch { return {}; }
  }

  private async check(): Promise<void> {
    if (!this.options.root || !this.options.install) return;
    const now = (this.options.now ?? Date.now)();
    if (this.pending) return this.pending;
    if (now - this.checkedAt < interval) return;
    this.checkedAt = now;
    this.pending = (async () => {
      try {
        const installation = dirname(dirname(this.options.root!));
        if (await realpath(join(installation, "current")) !== await realpath(this.options.root!)) return;
        await readFile(join(installation, "install.json"), "utf8");
        const installed = JSON.parse(await readFile(join(this.options.root!, "release.json"), "utf8"));
        const response = await (this.options.fetch ?? fetch)("https://api.github.com/repos/hartphoenix/tether/releases/latest", {
          headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000), redirect: "error",
        });
        if (!response.ok) throw new Error("Release check unavailable");
        const release = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
        const tag = release.tag_name ?? "", version = tag.replace(/^v/, "");
        const asset = `tether-darwin-${this.options.architecture ?? process.arch}.tar.gz`;
        const complete = [asset, `${asset}.sha256`].every(name => release.assets?.some(item => item.name === name && item.browser_download_url === `${repository}/releases/download/${tag}/${name}`));
        this.available = /^v\d+\.\d+\.\d+$/.test(tag) && !release.draft && !release.prerelease && complete && newerVersion(version, installed.version)
          ? { version, tag, notes: `${repository}/releases/tag/${tag}` } : null;
      } catch { /* Offline, unpublished, malformed, and rate-limited responses stay quiet. */ }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async status(): Promise<UpdateStatus> {
    await this.check();
    const state = await this.state();
    return { available: state.dismissed === this.available?.tag ? null : this.available, installing: this.installing, failed: state.failed === true };
  }

  async dismiss(tag: unknown): Promise<void> {
    if (!this.available || tag !== this.available.tag || this.installing) throw new Error("Update changed. Refresh Folio.");
    await writeUpdateState(this.options.config, { dismissed: this.available.tag });
  }

  async install(tag: unknown): Promise<void> {
    if (this.installing) return;
    await this.check();
    if (!this.available || tag !== this.available.tag || !this.options.install) throw new Error("Update unavailable. Refresh Folio.");
    // Claim before awaiting: two views must not launch competing installers.
    if (this.installing) return;
    this.installing = true;
    try {
      await writeUpdateState(this.options.config, {});
      await this.options.install(this.available.tag);
    } catch (cause) { this.installing = false; throw cause; }
  }
}
