import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, writeFile, lstat, chmod } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { acquireStartupLock, type TetherConfig } from "../server/config";
import { statusDaemon } from "../server/lifecycle";

type Manifest = { format: "tether-backup-v1"; files: Record<string, string> };
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const allowed = (name: string) => ["tether.sqlite", "preferences.json", "launch.json", "recent-files.json", "updates.json"].includes(name) || /^documents\/[^/]+\.md$/.test(name);

/** A stopped daemon plus its startup lock prevents concurrent app writes. */
export async function backupState(config: TetherConfig, output: string): Promise<{ directory: string; files: number }> {
  const directory = resolve(output);
  if (!relative(config.configDir, directory).startsWith("..")) throw new Error("Put backups outside the live configuration directory.");
  const lock = await acquireStartupLock(config);
  try {
    if ((await statusDaemon(config)).running) throw new Error("Quit Tether before backup: tether daemon stop");
    const databasePath = join(config.configDir, "tether.sqlite");
    if (!(await lstat(databasePath)).isFile()) throw new Error("No private database to back up.");
    await mkdir(directory, { mode: 0o700 });
    const manifest: Manifest = { format: "tether-backup-v1", files: {} };
    const write = async (name: string, data: Uint8Array) => {
      await mkdir(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, name), data, { flag: "wx", mode: 0o600 });
      manifest.files[name] = digest(data);
    };
    const db = new Database(databasePath, { readonly: true });
    try { db.query("VACUUM INTO ?").run(join(directory, "tether.sqlite")); } finally { db.close(); }
    await chmod(join(directory, "tether.sqlite"), 0o600);
    manifest.files["tether.sqlite"] = digest(await readFile(join(directory, "tether.sqlite")));
    for (const name of ["preferences.json", "launch.json", "recent-files.json", "updates.json"]) {
      const path = join(config.configDir, name);
      const info = await lstat(path).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
      if (info) { if (!info.isFile()) throw new Error(`Unsupported state file: ${name}`); await write(name, await readFile(path)); }
    }
    const documents = join(config.configDir, "documents");
    const names = await readdir(documents).catch(cause => { if (cause.code === "ENOENT") return []; throw cause; });
    for (const name of names) {
      if (!allowed(`documents/${name}`)) continue;
      const path = join(documents, name);
      if (!(await lstat(path)).isFile()) throw new Error(`Unsupported document: ${name}`);
      await write(`documents/${name}`, await readFile(path));
    }
    // Publish the manifest last; an incomplete directory is not a backup.
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { directory, files: Object.keys(manifest.files).length };
  } finally { await lock.release(); }
}

/** Restore into a new directory only. Live state and Markdown are never replaced. */
export async function restoreState(source: string, destination: string): Promise<{ directory: string; files: number }> {
  const directory = resolve(destination);
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "tether-backup-v1" || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !manifest.files["tether.sqlite"]) throw new Error("Invalid backup manifest.");
  const files: Array<[string, Buffer]> = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!allowed(name) || name.includes("..")) throw new Error("Invalid backup file path.");
    const path = join(source, name);
    if (!(await lstat(path)).isFile()) throw new Error("Backup files must be regular files.");
    const data = await readFile(path);
    if (digest(data) !== expected) throw new Error(`Backup checksum mismatch: ${name}`);
    files.push([name, data]);
  }
  const snapshot = Database.deserialize(files.find(([name]) => name === "tether.sqlite")![1]);
  try {
    const check = snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (check.integrity_check !== "ok") throw new Error("Backup database integrity check failed.");
  } finally { snapshot.close(); }
  await mkdir(directory, { mode: 0o700 });
  for (const [name, data] of files) {
    await mkdir(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, name), data, { flag: "wx", mode: 0o600 });
  }
  return { directory, files: files.length };
}
