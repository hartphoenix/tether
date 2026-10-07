import { access, chmod, mkdir, realpath, writeFile, lstat, readFile, rename, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateProfile } from "../src/server/config";

export type HeadlessInstall = {
  role: "service" | "connector";
  platform: "darwin" | "linux";
  checkout: string;
  directory: string;
  bun: string;
  profile: string;
  connection?: string;
  configDirectory?: string;
  runtimeDirectory?: string;
  supervise?: boolean;
};

const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// systemd expands percent specifiers and dollars in ExecStart, even in quotes.
const systemd = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`;
function path(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Installation paths must be absolute and contain no control characters.");
  return value;
}

/** Source deployments retain the checkout; generated units never contain credentials. */
export function headlessAssets(input: HeadlessInstall) {
  if (!["service", "connector"].includes(input.role) || !["darwin", "linux"].includes(input.platform)) throw new Error("Choose service or connector on macOS or Linux.");
  validateProfile(input.profile);
  for (const value of [input.checkout, input.directory, input.bun, input.connection, input.configDirectory, input.runtimeDirectory]) if (value !== undefined) path(value);
  if (input.role === "connector" && !input.connection) throw new Error("A connector requires --connection pointing to its private credential file.");
  if (input.role === "service" && input.connection) throw new Error("The profile service does not use a client connection file.");
  const label = `org.tether.source.${input.role}.${input.profile}`;
  const launcher = join(input.directory, "run");
  const command = input.role === "service"
    ? [input.bun, "--no-env-file", join(input.checkout, "src/server/login.ts")]
    : [input.bun, "--no-env-file", join(input.checkout, "src/cli/public.ts"), "connector", "run", "--connection", input.connection!];
  const environment = [`export TETHER_PROFILE=${shell(input.profile)}`,
    ...(input.configDirectory ? [`export TETHER_CONFIG_DIR=${shell(input.configDirectory)}`] : []),
    ...(input.runtimeDirectory ? [`export TETHER_RUNTIME_DIR=${shell(input.runtimeDirectory)}`] : [])];
  const script = `#!/bin/sh\nset -eu\numask 077\nunset TETHER_INSTALL_ROOT\n${environment.join("\n")}\ncd ${shell(input.checkout)}\nexec ${command.map(shell).join(" ")}\n`;
  const unitName = `${label}.${input.platform === "darwin" ? "plist" : "service"}`;
  const unit = input.platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array><string>${xml(launcher)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ExitTimeOut</key><integer>60</integer>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(join(input.directory, "stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(input.directory, "stderr.log"))}</string>\n</dict></plist>\n`
    : `[Unit]\nDescription=Tether ${input.role} (${input.profile})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemd(launcher)}\nRestart=always\nRestartSec=10\nTimeoutStopSec=60\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  return { label, launcher, script, unitName, unit };
}

export async function installHeadless(input: HeadlessInstall) {
  const normalized = { ...input, checkout: await realpath(input.checkout), bun: await realpath(input.bun) };
  const assets = headlessAssets(normalized);
  await access(normalized.bun, constants.X_OK);
  await access(join(normalized.checkout, "src/server/login.ts"));
  await access(join(normalized.checkout, "src/cli/public.ts"));
  await access(join(normalized.checkout, "node_modules/typescript/package.json"));
  const marker = join(normalized.directory, "installation.json");
  await mkdir(normalized.directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(normalized.directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error("The installation directory must be an owner-only directory, not a symlink.");
  const previous = await readFile(marker, "utf8").then(text => JSON.parse(text)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (previous && ["role", "profile", "connection", "configDirectory", "runtimeDirectory"].some(key => previous[key] !== input[key as keyof HeadlessInstall])) throw new Error("This directory belongs to a different installation. Preserve its role, profile, connection and configuration/runtime directories.");
  const unitPath = join(normalized.directory, assets.unitName);
  if (!previous) {
    // Adopt only exact legacy assets or our own interrupted, empty installation.
    for (const name of await readdir(normalized.directory)) {
      const expected = name === "run" ? assets.script : name === assets.unitName ? assets.unit : null;
      if (expected === null || !(await lstat(join(normalized.directory, name))).isFile() || await readFile(join(normalized.directory, name), "utf8") !== expected) throw new Error("Unrecognized installation contents; nothing has been replaced.");
    }
    await writeFile(marker, JSON.stringify({ role: input.role, profile: input.profile, connection: input.connection, configDirectory: input.configDirectory, runtimeDirectory: input.runtimeDirectory }) + "\n", { mode: 0o600, flag: "wx" });
  }
  for (const [destination, contents, mode] of [[assets.launcher, assets.script, 0o700], [unitPath, assets.unit, 0o600]] as const) {
    const existing = await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing && (!existing.isFile() || existing.uid !== process.getuid?.())) throw new Error("Installation assets must be owned regular files.");
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, contents, { flag: "wx", mode }); await rename(temporary, destination);
  }
  if (input.supervise) await superviseHeadless(normalized, assets.unitName, assets.unit, assets.label);
  return { role: normalized.role, profile: normalized.profile, checkout: normalized.checkout, launcher: assets.launcher, unit: unitPath, label: assets.label, repaired: !!previous, supervised: !!input.supervise };
}

async function supervisorCommand(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code && !allowFailure) throw new Error(`Supervisor operation ${args[0]} ${args[1]} failed; inspection may be restricted in this environment.`);
}
export async function superviseHeadless(input: HeadlessInstall, unitName: string, unit: string, label: string) {
  const directory = input.platform === "darwin" ? join(homedir(), "Library/LaunchAgents") : join(homedir(), ".config/systemd/user");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, unitName);
  const old = await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (old && (!old.isFile() || old.uid !== process.getuid?.() || !(await readFile(destination, "utf8")).includes(input.directory))) throw new Error("An unrelated supervisor already uses this profile. It has not been replaced.");
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, unit, { mode: 0o600, flag: "wx" }); await rename(temporary, destination);
  if (input.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    await supervisorCommand(["launchctl", "bootout", `${domain}/${label}`], true);
    await supervisorCommand(["launchctl", "bootstrap", domain, destination]);
  } else {
    await supervisorCommand(["systemctl", "--user", "daemon-reload"]);
    await supervisorCommand(["systemctl", "--user", "enable", "--now", unitName]);
    await supervisorCommand(["systemctl", "--user", "restart", unitName]);
  }

}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write("Usage: bun scripts/install-headless.ts --role service|connector --directory <new-directory> --profile <profile> [--connection <private-file>] [--checkout <checkout>] [--bun <bun>] [--config-directory <directory>] [--runtime-directory <directory>]\n");
    } else {
      const flags = new Map<string, string>();
      const allowed = ["--role", "--directory", "--profile", "--connection", "--checkout", "--bun", "--config-directory", "--runtime-directory", "--supervise"];
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!, value = args[index + 1];
        if (!allowed.includes(name) || !value || value.startsWith("--") || flags.has(name)) throw new Error("Invalid installation arguments; use --help.");
        flags.set(name, value);
      }
      const role = flags.get("--role"), directory = flags.get("--directory"), profile = flags.get("--profile");
      if ((role !== "service" && role !== "connector") || !directory || !profile) throw new Error("--role, --directory, and --profile are required.");
      if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Headless source deployment supports macOS and Linux.");
      const result = await installHeadless({ supervise: flags.get("--supervise") === "yes", role, platform: process.platform, directory: resolve(directory), profile,
        checkout: resolve(flags.get("--checkout") ?? dirname(import.meta.dir)), bun: resolve(flags.get("--bun") ?? process.execPath),
        ...(flags.has("--connection") ? { connection: resolve(flags.get("--connection")!) } : {}),
        ...(flags.has("--config-directory") ? { configDirectory: resolve(flags.get("--config-directory")!) } : {}),
        ...(flags.has("--runtime-directory") ? { runtimeDirectory: resolve(flags.get("--runtime-directory")!) } : {}),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Headless installation failed."}\n`); process.exitCode = 1; }
}
