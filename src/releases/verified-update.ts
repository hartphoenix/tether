import { Updater, type TargetFile } from "tuf-js";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { acquireFileLock } from "../documents/path-lock";

export type VerifiedRelease = { version: string; tag: string; notes: string; sha256: string };
const stable = /^\d+\.\d+\.\d+$/;
export function newerVersion(candidate: string, installed: string): boolean {
  if (!stable.test(candidate) || !stable.test(installed)) return false;
  const a = candidate.split(".").map(BigInt), b = installed.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function baseUrl(value: unknown): string {
  const url = new URL(typeof value === "string" ? value : "");
  // Loopback supports isolated signed repositories; no credentials are sent.
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) || url.username || url.password || url.search || url.hash) throw new Error("Invalid trusted update repository.");
  return url.href;
}

/** Uses the installed trust root, never a key supplied by downloaded metadata.
 * TUF owns signature, expiry, rollback, hash/length, and root-rotation checks. */
export async function withVerifiedRelease<T>(root: string, action: (release: VerifiedRelease | null, download: () => Promise<string>) => Promise<T>, architecture: string = process.arch): Promise<T> {
  const installation = dirname(dirname(root));
  if (await realpath(join(installation, "current")) !== await realpath(root)) throw new Error("Run the current installed Tether release to update.");
  let trust: { metadataUrl?: string; targetsUrl?: string };
  try { trust = JSON.parse(await readFile(join(root, "update-trust.json"), "utf8")); }
  catch { throw new Error("This installation has no update trust root. Install a publisher-authenticated release before updating."); }
  const metadataUrl = baseUrl(trust.metadataUrl), targetsUrl = baseUrl(trust.targetsUrl);
  const cache = join(installation, "update-metadata");
  await mkdir(cache, { recursive: true, mode: 0o700 }); await chmod(cache, 0o700);
  const lock = await acquireFileLock(join(cache, "writer.lock"));
  let archive: string | undefined;
  try {
    await copyFile(join(root, "update-root.json"), join(cache, "root.json"), constants.COPYFILE_EXCL).catch(cause => { if (cause.code !== "EEXIST") throw cause; });
    const updater = new Updater({ metadataDir: cache, metadataBaseUrl: metadataUrl, targetBaseUrl: targetsUrl, config: { fetchTimeout: 10_000, fetchRetries: 0, rootMaxLength: 512_000, timestampMaxLength: 64_000, snapshotMaxLength: 512_000, targetsMaxLength: 1_048_576, maxDelegations: 8 } });
    await updater.refresh();
    const installed = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
    const target: TargetFile | undefined = await updater.getTargetInfo(`tether-${process.platform}-${architecture}.tar.gz`);
    if (!target) return await action(null, async () => { throw new Error("No compatible update."); });
    const { version, platform, architecture: targetArch } = target.custom;
    if (typeof version !== "string" || !stable.test(version) || platform !== process.platform || targetArch !== architecture || !/^[a-f0-9]{64}$/.test(target.hashes.sha256 ?? "") || target.length > 512 * 1024 * 1024) throw new Error("Signed update metadata has an invalid version, platform, architecture, or archive size.");
    if (!newerVersion(version, installed.version)) return await action(null, async () => { throw new Error("Update would not advance the installed version."); });
    const release = { version, tag: `v${version}`, notes: `https://github.com/hartphoenix/tether/releases/tag/v${version}`, sha256: target.hashes.sha256! };
    return await action(release, async () => {
      archive = join(cache, `candidate-${crypto.randomUUID()}.tar.gz`);
      await updater.downloadTarget(target, archive);
      await chmod(archive, 0o600);
      return archive;
    });
  } finally {
    if (archive) await rm(archive, { force: true });
    await lock.release();
  }
}

export async function discoverVerifiedRelease(root: string, architecture: string = process.arch): Promise<VerifiedRelease | null> {
  return withVerifiedRelease(root, async release => release, architecture);
}

/** Only the installed verifier may select and authenticate a network candidate. */
export async function installVerifiedRelease(root: string, config: import("../server/config").TetherConfig, requestedTag?: string): Promise<string> {
  return withVerifiedRelease(root, async (release, download) => {
    if (!release) return "No newer authenticated release is available.";
    if (requestedTag && requestedTag !== release.tag) throw new Error("The requested release is no longer the authenticated update. Check again.");
    const archive = await download();
    const installation = dirname(dirname(root));
    const metadata = JSON.parse(await readFile(join(installation, "install.json"), "utf8"));
    if (typeof metadata.binDirectory !== "string" || !isAbsolute(metadata.binDirectory)) throw new Error("Invalid installation metadata.");
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, { TETHER_INSTALL_DIR: installation, TETHER_BIN_DIR: metadata.binDirectory, TETHER_PROFILE: config.profile, TETHER_CONFIG_DIR: config.configDir, TETHER_RUNTIME_DIR: config.runtimeDir });
    const child = Bun.spawn(["/bin/bash", join(root, "install.sh"), "--archive", archive, "--sha256", release.sha256, "--version", release.tag, "--no-open"], { env, stdout: "pipe", stderr: "pipe" });
    const { diagnosticOutput } = await import("../shared/diagnostics");
    const [code, stdout, stderr] = await Promise.all([child.exited, diagnosticOutput(child.stdout), diagnosticOutput(child.stderr)]);
    if (code !== 0) throw Object.assign(new Error(`Verified installation failed. ${stderr}`), { code: "update_failed", exitCode: code, details: { outcome: "outcome_unknown", stage: "installer", stdout, stderr } });
    return stdout;
  });
}
