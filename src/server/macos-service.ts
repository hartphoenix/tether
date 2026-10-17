import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export type ServiceStatus = 0 | 1 | 2 | 3;
export type ServiceOperation = "status" | "register" | "unregister";
export type ServiceCommand = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export const serviceCommand: ServiceCommand = async args => {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
};
export async function serviceControl(app: string, label: string, operation: ServiceOperation, command = serviceCommand): Promise<ServiceStatus> {
  const result = await command([join(app, "Contents/MacOS/tether"), "--service", `${label}.plist`, operation]);
  if (result.code !== 0) throw new Error(`Tether service ${operation} failed: ${result.stderr.trim()}`);
  const value = result.stdout.trim();
  if (!/^[0-3]$/.test(value)) throw new Error("Invalid service registration status.");
  const status = Number(value);
  if (![0, 1, 2, 3].includes(status)) throw new Error("Invalid service registration status.");
  return status as ServiceStatus;
}
export const fileInfo = (path: string) => lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });

/** This stable, small native app follows the release pointer; it never embeds an old Bun runtime. */
export async function prepareServiceApp(app: string, template: string, identifier: string, label: string, plist: string, command = serviceCommand) {
  const existing = await fileInfo(app);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.())) throw new Error("Unsafe service application directory.");
  if (existing) {
    // Do not replace a registered app or reset macOS consent during repeat setup.
    const current = await readFile(join(app, "Contents/Library/LaunchAgents", `${label}.plist`), "utf8");
    if (current !== plist) throw new Error("Service configuration changed. Disable startup before repairing its application.");
    return;
  }
  await mkdir(dirname(app), { recursive: true, mode: 0o700 });
  const staging = join(dirname(app), `.tether-${crypto.randomUUID()}.app`);
  try {
    for (const directory of ["MacOS", "Resources", "Library/LaunchAgents"]) await mkdir(join(staging, "Contents", directory), { recursive: true });
    await copyFile(join(template, "Contents/Frameworks/tether-service"), join(staging, "Contents/MacOS/tether"));
    await chmod(join(staging, "Contents/MacOS/tether"), 0o755);
    await copyFile(join(template, "Contents/Resources/tether.icns"), join(staging, "Contents/Resources/tether.icns"));
    await writeFile(join(staging, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(identifier)}</string>
<key>CFBundleName</key><string>tether</string><key>CFBundleDisplayName</key><string>tether</string>
<key>CFBundleExecutable</key><string>tether</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleIconFile</key><string>tether.icns</string>
<key>LSUIElement</key><true/><key>LSBackgroundOnly</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>\n`);
    await writeFile(join(staging, "Contents/Library/LaunchAgents", `${label}.plist`), plist);
    // Local bundle integrity only; does not use Developer ID or publisher credentials.
    const signed = await command(["/usr/bin/codesign", "--force", "--sign", "-", staging]);
    if (signed.code) throw new Error(`Service application signing failed: ${signed.stderr}`);
    await rename(staging, app);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export type LegacyService = { path: string; label: string; ownedPath: string };
/** Inspect only the exact legacy job owned by this installation. Never use a wildcard. */
export async function inspectLegacy(legacy: LegacyService, command = serviceCommand) {
  const info = await fileInfo(legacy.path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Unsafe legacy service registration; preserved.");
  const parsed = await command(["/usr/bin/plutil", "-convert", "json", "-o", "-", legacy.path]);
  if (parsed.code) throw new Error("Invalid legacy service registration; preserved.");
  const plist = JSON.parse(parsed.stdout);
  if (plist.Label !== legacy.label || !Array.isArray(plist.ProgramArguments) || !plist.ProgramArguments.some((arg: unknown) => typeof arg === "string" && (arg === legacy.ownedPath || arg.startsWith(`${legacy.ownedPath}/`)))) throw new Error("An unrelated service uses this label; preserved.");
  const domain = `gui/${process.getuid!()}`;
  const disabled = await command(["/bin/launchctl", "print-disabled", domain]);
  if (disabled.code) throw new Error("Cannot inspect legacy background permissions; preserved.");
  const isDisabled = disabled.stdout.split("\n").some(line => line.includes(`"${legacy.label}"`) && /=>\s*true/.test(line));
  return { disabled: isDisabled, loaded: (await command(["/bin/launchctl", "print", `${domain}/${legacy.label}`])).code === 0 };
}

export async function registerService(app: string, label: string, legacy: LegacyService, command = serviceCommand) {
  const old = await inspectLegacy(legacy, command);
  const status = await serviceControl(app, label, "status", command);
  const domain = `gui/${process.getuid!()}`;
  if (old?.disabled) return { status: 0 as ServiceStatus, legacyDisabled: true };
  const archive = join(dirname(app), "retired", `${legacy.label}.plist`);
  if (old && await fileInfo(archive)) throw new Error("A previous legacy service backup exists; registration preserved.");
  if (old) await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
  // macOS retains approval decisions. Never unregister/re-register a denied item to bypass them.
  const indexed = await command([lsregister, "-f", app]);
  if (indexed.code) throw new Error("Could not register the Tether application with Launch Services.");
  if (old?.loaded && (await command(["/bin/launchctl", "bootout", `${domain}/${legacy.label}`])).code) throw new Error("Could not stop the legacy service; migration cancelled.");
  let archived = false;
  try {
    if (old) { await rename(legacy.path, archive); archived = true; }
    const next = status === 1 || status === 2 ? status : await serviceControl(app, label, "register", command);
    if (next !== 1 && next !== 2) throw new Error("macOS did not register the Tether service.");
    return { status: next, legacyDisabled: false };
  } catch (error) {
    if (old) {
      if (archived) await rename(archive, legacy.path);
      if (old.loaded && (await command(["/bin/launchctl", "bootstrap", domain, legacy.path])).code) throw new Error(`Registration failed and legacy startup could not be restored: ${error}`);
    }
    throw error;
  }
}
