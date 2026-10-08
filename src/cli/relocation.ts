import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, unlink, lstat, rm, open, link } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { TetherConfig } from "../server/config";
import { acquireStartupLock } from "../server/config";
import { statusDaemon, stopDaemon } from "../server/lifecycle";
import { readSharedConfig, writeSharedConfig } from "../server/shared-profile";
import { backupState } from "./backup";

type Transfer = { id: string; destination: string; sourceMachineId: string; destinationMachineId?: string; releaseHash: string; backup: string; attemptId?: string };
type Fence = Transfer & { phase: "prepared" | "released"; secret: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fencePath = (config: TetherConfig) => join(config.configDir, "authority-fence.json");
async function readPrivate<T>(path: string): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 8192) throw new Error("Transfer records must be small, owner-only regular files.");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
async function writePrivate(path: string, value: unknown, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  try { if (exclusive) await link(temporary, path); else await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function assertAuthority(config: TetherConfig): Promise<void> {
  const fenced = await lstat(fencePath(config)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (fenced) throw new Error("This authority is fenced for relocation. Resume the transfer, or roll back before release; do not restart it manually.");
}

/** The release receipt is written only after the old authority permanently gives up writes. */
export async function relocate(config: TetherConfig, action: string, input: { output?: string; destination?: string; receipt?: string; attemptId?: string }) {
  const path = fencePath(config);
  if (action === "prepare") {
    if (!input.output || !input.destination?.trim()) throw new Error("Choose a backup directory and destination machine.");
    const lock = await acquireStartupLock(config);
    try {
    let fence = await readPrivate<Fence>(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    const output = resolve(input.output);
    if (fence && (fence.backup !== output || fence.destination !== input.destination || fence.attemptId !== input.attemptId)) throw new Error("A different transfer is already in progress.");
    if (!fence) {
      const db = new Database(join(config.configDir, "tether.sqlite"), { readonly: true });
      let sourceMachineId: string, destinationMachineId: string | undefined;
      try {
        sourceMachineId = (db.query("SELECT value FROM settings WHERE key='local_machine_id'").get() as {value:string}).value;
        if (input.attemptId) {
          const row = db.query("SELECT answers,expires_at,phase FROM setup_attempts WHERE id=?").get(input.attemptId) as {answers:string;expires_at:number;phase:string} | null;
          const answers = row && JSON.parse(row.answers);
          if (!row || row.expires_at <= Date.now() || row.phase === "cancelled" || !answers.relocate || answers.hub !== input.destination) throw new Error("Select the current relocation attempt and its chosen destination.");
          if (answers.machineId) {
            const machine = db.query("SELECT name FROM file_machines WHERE id=?").get(answers.machineId) as {name:string} | null;
            if (!machine || machine.name !== input.destination || answers.machineId === sourceMachineId) throw new Error("Choose a different connected computer as the destination.");
            destinationMachineId = answers.machineId;
          }
        }
      } finally { db.close(); }
      const secret = randomBytes(32).toString("base64url");
      fence = { id: randomUUID(), destination: input.destination, sourceMachineId, destinationMachineId, releaseHash: hash(secret), secret, phase: "prepared", backup: output, attemptId: input.attemptId };
      await writePrivate(path, fence, true);
    }
    if (fence.phase === "released") throw new Error("The old authority has been released; activate or repair the destination.");
    if ((await statusDaemon(config)).running) await stopDaemon(config);
    const transfer: Transfer = { id: fence.id, destination: fence.destination, sourceMachineId: fence.sourceMachineId, destinationMachineId: fence.destinationMachineId, releaseHash: fence.releaseHash, backup: output, attemptId: fence.attemptId };
    await writePrivate(join(config.configDir, "authority-transfer.json"), transfer);
    const exists = await lstat(output).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!exists) {
      const temporary = `${output}.transfer-${fence.id}`;
      // This exact staging path is recorded by the private fence, never supplied by a remote client.
      await rm(temporary, { recursive: true, force: true });
      await backupState(config, temporary, true); await rename(temporary, output);
    } else {
      const recorded = await readPrivate<Transfer>(join(output, "authority-transfer.json"));
      if (recorded.id !== fence.id) throw new Error("The backup destination belongs to another transfer.");
      await readFile(join(output, "manifest.json"));
    }
    return { transferId: fence.id, backup: output, phase: fence.phase, next: "Restore and verify the destination and its file-machine routes before releasing this authority." };
    } finally { await lock.release(); }
  }
  if (action === "release") {
    if (!input.output) throw new Error("Choose a private receipt file to transfer to the destination.");
    const lock = await acquireStartupLock(config);
    try {
      const fence = await readPrivate<Fence>(path);
      if ((await statusDaemon(config)).running) throw new Error("Stop the fenced source before releasing it.");
      const output = resolve(input.output);
      if (output === path || output === join(config.configDir, "authority-transfer.json")) throw new Error("Choose a separate receipt file.");
      const existing = await readPrivate<{id:string;secret:string}>(output).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (existing && (existing.id !== fence.id || existing.secret !== fence.secret)) throw new Error("The receipt path already contains another file. It has not been replaced or released.");
      await writePrivate(path, { ...fence, phase: "released" });
      if (!existing) await writePrivate(output, { id: fence.id, secret: fence.secret }, true);
      return { transferId: fence.id, phase: "released", receipt: resolve(input.output), rollbackAllowed: false };
    } finally { await lock.release(); }
  }
  if (action === "rollback") {
    const lock = await acquireStartupLock(config);
    try {
      const fence = await readPrivate<Fence>(path);
      if (fence.phase !== "prepared") throw new Error("Release is irreversible: the destination may have accepted writes. Repair the destination instead.");
      await unlink(join(config.configDir, "authority-transfer.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
      await unlink(path);
      return { rolledBack: true, transferId: fence.id };
    } finally { await lock.release(); }
  }
  if (action === "activate") {
    if (!input.receipt) throw new Error("Transfer the source’s private release receipt first.");
    const lock = await acquireStartupLock(config);
    try {
      await assertAuthority(config);
      const transfer = await readPrivate<Transfer>(join(config.configDir, "authority-transfer.json"));
      const receipt = await readPrivate<{id:string;secret:string}>(resolve(input.receipt));
      if (receipt.id !== transfer.id || typeof receipt.secret !== "string" || hash(receipt.secret) !== transfer.releaseHash) throw new Error("This receipt does not release the restored authority.");
      if ((await statusDaemon(config)).running) throw new Error("Stop the destination while activating the restored authority.");
      const shared = await readSharedConfig(config); if (!shared) throw new Error("Configure the destination’s final HTTPS origin first.");
      const db = new Database(join(config.configDir, "tether.sqlite"));
      try {
        const current = (db.query("SELECT value FROM settings WHERE key='local_machine_id'").get() as {value:string}).value;
        if (current === transfer.sourceMachineId) db.transaction(() => {
          db.query("UPDATE settings SET value=? WHERE key='local_machine_id'").run(transfer.destinationMachineId ?? randomUUID());
          for (const table of ["reader_views", "ceremonies"]) if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
          // The destination requires fresh authorization at its final origin.
          db.query("UPDATE shared_clients SET revoked_at=? WHERE revoked_at IS NULL").run(Date.now());
          if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='setup_attempts'").get()) {
            db.exec("UPDATE setup_attempts SET contact=NULL,phase='cancelled'");
            if (transfer.attemptId) db.query("UPDATE setup_attempts SET phase='awaiting verification',expires_at=? WHERE id=?").run(Date.now() + 86_400_000, transfer.attemptId);
          }
        })();
      } finally { db.close(); }
      await writeSharedConfig(config, { ...shared, active: true });
      return { active: true, transferId: transfer.id, sourceMachineId: transfer.sourceMachineId, next: "Enroll the owner at this HTTPS origin, then re-pair the retained file machines, including the former hub." };
    } finally { await lock.release(); }
  }
  throw new Error("Unknown relocation operation.");
}
