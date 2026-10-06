import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { acquireStartupLock, prepareConfig, type TetherConfig } from "../server/config";
import { controlRequest, statusDaemon } from "../server/lifecycle";
import { readSharedConfig, writeSharedConfig } from "../server/shared-profile";
import { sharedOrigin, type SharedCredential } from "../remote/shared-auth";
import { beginSharedPairing, pollSharedPairing, readSharedCredential, sharedRequest, writeSharedCredential, type PairingRequest } from "../remote/shared-client";
import { runFileConnector } from "../remote/connector";
import { LocalFileAccess } from "../documents/file-access";
import { optionalFlag, positiveInteger, requiredFlag, usage, type ParsedCommand } from "./commands";

export async function remoteSetup(parsed: ParsedCommand, config: TetherConfig): Promise<unknown | undefined> {
  const command = parsed.spec.name;
  if (command === "shared.configure" || command === "shared.activate") {
    await prepareConfig(config);
    const lock = await acquireStartupLock(config);
    try {
      if ((await statusDaemon(config)).running) throw new Error("Stop this profile's daemon before changing its public endpoint or authority.");
      if (command === "shared.configure") {
        const previous = await readSharedConfig(config);
        const value = { origin: requiredFlag(parsed, "--origin"), port: Number(requiredFlag(parsed, "--port")), owner: optionalFlag(parsed, "--owner") ?? previous?.owner ?? "Tether owner", active: previous?.active ?? true };
        await writeSharedConfig(config, value);
        return { configured: true, origin: value.origin, port: value.port, next: "Start the daemon, configure HTTPS to its loopback port, then run tether shared enroll." };
      }
      const value = await readSharedConfig(config);
      if (!value) throw new Error("No restored shared profile is configured.");
      if (value.active) return { active: true, changed: false };
      const db = new Database(join(config.configDir, "tether.sqlite"));
      db.exec("PRAGMA foreign_keys=ON");
      let previousMachineId: string | undefined;
      try {
        previousMachineId = (db.query("SELECT value FROM settings WHERE key='local_machine_id'").get() as {value:string} | null)?.value;
        if (!parsed.flags.has("--same-file-machine")) db.transaction(() => {
          db.query("INSERT OR REPLACE INTO settings(key,value) VALUES ('local_machine_id',?)").run(crypto.randomUUID());
          // Legacy local views authorize paths on their original file machine.
          // They cannot become grants for matching paths on a restored host.
          if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='reader_views'").get()) db.exec("DELETE FROM reader_views");
        })();
      } finally { db.close(); }
      await writeSharedConfig(config, { ...value, active: true });
      return { active: true, previousMachineId, sameFileMachine: parsed.flags.has("--same-file-machine"), message: "This profile is now the selected authority. Keep the previous service stopped." };
    } finally { await lock.release(); }
  }
  if (["shared.enroll", "shared.recover", "shared.status"].includes(command)) return controlRequest(config, `/control/shared/${command.split(".")[1]}`, {});
  if (command === "remote.pair") {
    const destination = resolve(requiredFlag(parsed, "--connection")), kind = optionalFlag(parsed, "--kind") ?? "agent";
    if (kind !== "agent" && kind !== "connector") usage("--kind must be agent or connector.");
    const origin = sharedOrigin(requiredFlag(parsed, "--origin"));
    const pair = await beginSharedPairing(origin, requiredFlag(parsed, "--name"), kind, { machineId: optionalFlag(parsed, "--machine") });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const file = await open(`${destination}.pending`, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ origin, pair })); await file.sync(); } finally { await file.close(); }
    return { verificationUrl: pair.verificationUrl, code: pair.code, expiresAt: pair.expiresAt, connection: destination, next: "Approve in the owner browser, then run tether remote complete --connection with this same file." };
  }
  if (command === "remote.complete") {
    const destination = resolve(requiredFlag(parsed, "--connection"));
    const file = await open(`${destination}.pending`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let pending: {origin:string;pair:PairingRequest};
    try {
      const info = await file.stat();
      if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 8192) throw new Error("Pairing state must be an owner-only regular file.");
      pending = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    const credential = await pollSharedPairing(pending.origin, pending.pair);
    if (!credential) return { pending: true, verificationUrl: pending.pair.verificationUrl, code: pending.pair.code };
    await writeSharedCredential(destination, credential);
    await unlink(`${destination}.pending`);
    return { enrolled: true, clientId: credential.clientId, machineId: credential.machineId, expiresAt: credential.expiresAt, connection: destination };
  }
  if (command === "remote.endpoint") {
    const destination = resolve(requiredFlag(parsed, "--connection")), credential = await readSharedCredential(destination);
    await writeSharedCredential(destination, { ...credential, origin: sharedOrigin(requiredFlag(parsed, "--origin")) });
    return { updated: true, origin: requiredFlag(parsed, "--origin") };
  }
  if (command === "connector.run") {
    const path = resolve(requiredFlag(parsed, "--connection")), credential = await readSharedCredential(path);
    if (!credential.machineId) throw new Error("Enroll a connector client to serve files.");
    const stop = new AbortController();
    const cancel = () => stop.abort();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, cancel);
    try { await runFileConnector({ endpoint: credential.origin, token: credential.token, machineId: credential.machineId, files: new LocalFileAccess(), lockPath: join("/tmp", `tether-connectors-${process.getuid?.() ?? "local"}`, `${credential.machineId}.lock`), signal: stop.signal }); }
    finally { for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, cancel); }
    return { stopped: true, machineId: credential.machineId };
  }
  return undefined;
}

export function remoteAddress(value: string, machineId?: string): Record<string, unknown> {
  if (value.startsWith("id:")) {
    const documentId = value.slice(3);
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) usage("Document IDs use id:<uuid>.");
    return { documentId };
  }
  if (!machineId) usage("A remote path requires --machine, or a connector connection with its machine ID.");
  return { path: value, machineId };
}

export async function remoteControl<T>(connection: SharedCredential, parsed: ParsedCommand, route: string, input: Record<string, unknown>): Promise<T> {
  if (!/^\/control\/(document|review|folio)\//.test(route)) throw new Error("This command is local to the service machine.");
  let operation = route.slice("/control/".length).replaceAll("/", ".");
  const machineId = optionalFlag(parsed, "--machine") ?? connection.machineId ?? undefined;
  let body = { ...input };
  if (operation === "document.save") body.expectedLocationVersion = positiveInteger(requiredFlag(parsed, "--expected-location-version"), "--expected-location-version");
  if (operation.startsWith("document.") || operation.startsWith("review.")) {
    delete body.path;
    body = { ...body, ...remoteAddress(parsed.positionals[0]!, machineId), ...(parsed.flags.has("--restore") ? { restoreArchived: true } : {}) };
  }
  if (operation === "folio.add") {
    const added = [];
    for (const path of parsed.positionals) added.push(await sharedRequest(connection, "document.register", { ...remoteAddress(path, machineId), ...(parsed.flags.has("--restore") ? { restoreArchived: true } : {}) }));
    return { added } as T;
  }
  if (["folio.archive", "folio.restore", "folio.pin", "folio.export"].includes(operation)) {
    delete body.paths;
    body.documentIds = parsed.positionals.map(value => { const address = remoteAddress(value, machineId); if (!address.documentId) usage("Use id:<uuid> for shared Folio selections."); return address.documentId; });
  }
  if (operation === "folio.locate") {
    operation = "document.relink";
    body = { ...remoteAddress(parsed.positionals[0]!, machineId), path: requiredFlag(parsed, "--new-path"), machineId };
  }
  return sharedRequest<T>(connection, operation, body);
}
