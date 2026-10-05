/** macOS source-pilot operations. Never reads the passkey store or configures Tailscale. */
import { mkdir, mkdtemp, readFile, writeFile, rename, symlink, readlink, unlink, rm, copyFile, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";

const repository = resolve(import.meta.dir, "..");
const root = join(repository, ".local/phone-reader-ops");
const label = "net.tether.phone-reader";
const domain = `gui/${process.getuid!()}`;
const service = `${domain}/${label}`;
const installed = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const staged = join(root, `${label}.plist`);
const current = join(root, "current");
const configPath = join(root, "options.json");
const ports = [8413, 8414];
type Options = { folioProfile?: string; document: string; owner: string; readerOrigin: string; approvalOrigin: string; stateDir: string; bun: string };

const usage = `bun scripts/phone-reader-ctl.ts COMMAND
  configure --document FILE --owner LOGIN --reader-origin HTTPS --approval-origin HTTPS --state-dir DIR [--folio-profile PROFILE]
  prepare REF   Export a committed release, install locked dependencies, run checks; no live change
  install REF   Install login agent and start a prepared release (owner approval required)
  start | stop | restart | status | logs
  deploy REF    Prepare, restart on REF, verify both ports; roll back on failure
Run from the original operations checkout. Enrollment remains a separate interactive owner action.`;

async function run(args: string[], cwd = repository, output: "inherit" | "pipe" = "pipe") {
  const child = Bun.spawn(args, { cwd, stdout: output, stderr: output });
  const [code, stdout] = await Promise.all([child.exited,
    output === "pipe" ? new Response(child.stdout).text() : Promise.resolve(""),
    output === "pipe" ? new Response(child.stderr).text() : Promise.resolve("")]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} failed (${code}).`);
  return stdout.trim();
}
async function options(): Promise<Options> { return JSON.parse(await readFile(configPath, "utf8")); }
async function exists(path: string) { return Bun.file(path).exists(); }
async function commit(ref: string) {
  const hash = await run(["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("Expected a commit hash.");
  return hash;
}
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
export function launchAgent(o: Options, base: string) {
  const args = [o.bun, join(base, "current/scripts/phone-reader.ts"), "--document", o.document, "--owner", o.owner,
    "--reader-origin", o.readerOrigin, "--approval-origin", o.approvalOrigin, "--state-dir", o.stateDir, ...(o.folioProfile ? ["--folio-profile", o.folioProfile] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(join(base, "current"))}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(base, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(base, "stderr.log"))}</string>
</dict></plist>\n`;
}
async function configure(args: string[]) {
  if (await exists(installed) || await exists(configPath)) throw new Error("Already configured; preserve existing options. Use a separate checkout for another pilot.");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--document", "--owner", "--reader-origin", "--approval-origin", "--state-dir", "--folio-profile"].includes(key) || !value || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  const get = (key: string) => { const value = values.get(key); if (!value) throw new Error(usage); return value; };
  const readerOrigin = new URL(get("--reader-origin")), approvalOrigin = new URL(get("--approval-origin"));
  for (const url of [readerOrigin, approvalOrigin]) if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use bare HTTPS origins.");
  if (readerOrigin.hostname === approvalOrigin.hostname) throw new Error("Use distinct reader and approval hostnames.");
  const o: Options = { document: await realpath(get("--document")), owner: get("--owner"), readerOrigin: readerOrigin.origin,
    approvalOrigin: approvalOrigin.origin, stateDir: resolve(get("--state-dir")), bun: process.execPath, ...(values.has("--folio-profile") ? { folioProfile: values.get("--folio-profile")! } : {}) };
  await writeFile(configPath, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
  await writeFile(staged, launchAgent(o, root), { mode: 0o600 });
  console.log(`Prepared ${staged}; nothing installed or restarted.`);
}
async function prepare(ref: string) {
  const hash = await commit(ref), destination = join(root, "releases", hash);
  if (await exists(join(destination, ".checked"))) return destination;
  const o = await options();
  await mkdir(join(root, "releases"), { recursive: true, mode: 0o700 });
  const snapshot = await mkdtemp(join(root, "releases/.preparing-"));
  const archive = join(snapshot, "release.tar");
  try {
    await run(["git", "archive", "--format=tar", `--output=${archive}`, hash]);
    await run(["tar", "-xf", archive, "-C", snapshot]);
    await unlink(archive);
    if (!await exists(join(snapshot, "src/remote/operations-health.ts"))) throw new Error("Ref predates supervised-runner health support.");
    await writeFile(join(snapshot, ".phone-reader-revision"), hash + "\n");
    await run([o.bun, "install", "--frozen-lockfile"], snapshot, "inherit");
    // Match CI: repository tests import the separately locked Paseo integration.
    await run(["npm", "ci", "--prefix", "integrations/paseo"], snapshot, "inherit");
    await run([o.bun, "run", "check"], snapshot, "inherit");
    await writeFile(join(snapshot, ".checked"), hash + "\n");
    await rename(snapshot, destination);
  } catch (error) { await rm(snapshot, { recursive: true, force: true }); throw error; }
  return destination;
}
async function occupied(port: number): Promise<boolean> {
  return new Promise(resolveResult => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); resolveResult(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
  });
}
async function freePorts() {
  if ((await Promise.all(ports.map(occupied))).some(Boolean)) throw new Error("Pilot ports are occupied; refusing to replace an unmanaged process. Owner must stop the foreground runner first.");
}
async function loaded() {
  try { await run(["launchctl", "print", service]); return true; } catch { return false; }
}
async function owned() {
  if (!await exists(installed)) throw new Error("Not installed. Owner must run install first.");
  if (await readFile(installed, "utf8") !== await readFile(staged, "utf8")) throw new Error("Installed service differs from staged configuration.");
}
/** bootout can return while launchd still exposes the exiting job. Closed ports alone
 * do not mean the label is available for bootstrap. */
export async function waitForUnload(isLoaded: () => Promise<boolean>, sleep: (ms: number) => Promise<unknown> = Bun.sleep) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!await isLoaded()) return;
    await sleep(200);
  }
  throw new Error("launchd did not finish unloading the service; refusing to start a replacement.");
}
async function stop() {
  await owned();
  if (!await loaded()) { await freePorts(); return; }
  await run(["launchctl", "bootout", service]);
  await waitForUnload(loaded);
  for (let i = 0; i < 150 && (await Promise.all(ports.map(occupied))).some(Boolean); i++) await Bun.sleep(200);
  await freePorts();
}
async function point(destination: string) {
  const temporary = join(root, "next");
  await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await symlink(destination, temporary); await rename(temporary, current);
}
async function probe(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!response.ok) return null;
    const data = await response.json();
    return data.service === "tether-phone-reader" && data.surface === (port === 8413 ? "reader" : "approval") && typeof data.revision === "string" ? data : null;
  } catch { return null; }
}
async function healthy(revision: string) {
  for (let i = 0; i < 90; i++) {
    const responses = await Promise.all(ports.map(probe));
    if (responses.every(value => value?.revision === revision)) return;
    await Bun.sleep(500);
  }
  throw new Error("Both local surfaces did not become healthy on the expected commit.");
}
async function start() {
  await owned();
  if (!await loaded()) { await freePorts(); await run(["launchctl", "bootstrap", domain, installed]); }
  const revision = (await readFile(join(current, ".phone-reader-revision"), "utf8")).trim();
  await healthy(revision);
}

/** Rollback changes only the code pointer; document, review and credential state are never restored. */
export async function transition(next: string, previous: string, ops: {
  stop(): Promise<void>; point(path: string): Promise<void>; start(): Promise<void>;
}) {
  await ops.stop();
  try { await ops.point(next); await ops.start(); }
  catch {
    try { await ops.stop(); await ops.point(previous); await ops.start(); }
    catch { throw new Error("Deploy and rollback failed. Service needs attention; inspect status and logs."); }
    throw new Error("Deploy failed; previous release restored and healthy.");
  }
}
async function status() {
  const responses = await Promise.all(ports.map(probe));
  const selected = await readlink(current).catch(() => null);
  const managed = await loaded();
  console.log(JSON.stringify({ managed, selected, reader: responses[0], approval: responses[1] }, null, 2));
  if (!managed || !selected || !responses.every(value => value?.revision === selected.split("/").at(-1))) process.exitCode = 1;
}
export async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === "--help") { console.log(usage); return; }
  if (!["configure", "prepare", "install", "start", "stop", "restart", "status", "logs", "deploy"].includes(command)) throw new Error(usage);
  if (command !== "configure" && rest.length !== (["prepare", "install", "deploy"].includes(command) ? 1 : 0)) throw new Error(usage);
  if (command === "status") return status();
  if (command === "logs") { await run(["tail", "-n", "80", join(root, "stdout.log"), join(root, "stderr.log")], root, "inherit"); return; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "operation.lock");
  try { await mkdir(lock); } catch { throw new Error("Another operation is active, or operation.lock remains after an interruption. Inspect before removing it."); }
  try {
    if (command === "configure") return await configure(rest);
    if (command === "prepare") { console.log(await prepare(rest[0]!)); return; }
    if (command === "install") {
      if (await exists(installed) || await loaded()) throw new Error("Service already installed; use start or deploy.");
      const hash = await commit(rest[0]!), destination = join(root, "releases", hash);
      if (!await exists(join(destination, ".checked"))) throw new Error("Run prepare REF before install.");
      await freePorts(); await point(destination);
      await mkdir(dirname(installed), { recursive: true }); await copyFile(staged, installed);
      try { await start(); } catch { await stop(); throw new Error("Initial startup failed; installed service stopped. Inspect logs before start."); }
    } else if (command === "start") await start();
    else if (command === "stop") await stop();
    else if (command === "restart") { await stop(); await start(); }
    else if (command === "deploy") {
      if (!await exists(installed)) throw new Error("Owner must install the service before deploy.");
      const previous = await readlink(current);
      const destination = await prepare(rest[0]!);
      await transition(destination, previous, { stop, point, start });
    }
    console.log(`${command}: complete`);
  } finally { await rm(lock, { recursive: true }); }
}
if (import.meta.main) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
