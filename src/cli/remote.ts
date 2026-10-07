import { writeRemoteBinding } from "../remote/binding";
import { setupReporting } from "./setup-reporting";
import { relocate } from "./relocation";
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

type PendingPair = { origin: string; pair: PairingRequest; replaces?: string };
async function readPending(path: string): Promise<PendingPair | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 8192) throw new Error("Pairing state must be an owner-only regular file.");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
async function credentialAccepted(connection: SharedCredential): Promise<boolean> {
  try { await sharedRequest(connection, "machines.list", {}); return true; }
  catch (error) {
    if (["unauthorized", "credential_expired"].includes((error as {code:string}).code)) return false;
    throw error; // Network failure is not revocation.
  }
}

export async function remoteSetup(parsed: ParsedCommand, config: TetherConfig): Promise<unknown | undefined> {
  const command = parsed.spec.name;
  if (["remote.setup", "remote.report"].includes(command)) return setupReporting(parsed);
  if (command.startsWith("relocate.")) return relocate(config, command.slice("relocate.".length), { output: optionalFlag(parsed, "--output"), destination: optionalFlag(parsed, "--destination"), receipt: optionalFlag(parsed, "--receipt"), attemptId: optionalFlag(parsed, "--attempt") });
  if (command === "shared.manage") return controlRequest(config, `/control/shared/${parsed.positionals[0]}`, JSON.parse(requiredFlag(parsed, "--input")));

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
      if (await Bun.file(join(config.configDir, "authority-transfer.json")).exists()) throw new Error("Use relocate activate with the source release receipt for this transfer.");
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
  if (command === "remote.bind") {
    const path = resolve(requiredFlag(parsed, "--connection")), connection = await readSharedCredential(path);
    await sharedRequest(connection, "machines.list", {});
    await prepareConfig(config);
    const lock = await acquireStartupLock(config);
    try {
    if (await Bun.file(join(config.configDir, "tether.sqlite")).exists()) throw new Error("This profile already has a local library. Select an unused client profile for the remote binding.");
    await writeRemoteBinding(config, { connection: path, receiver: optionalFlag(parsed, "--receiver") });
    return { bound: true, connection: path, receiver: optionalFlag(parsed, "--receiver"), profile: config.profile };
    } finally { await lock.release(); }
  }
  if (command === "remote.call") {
    const connection = await readSharedCredential(resolve(requiredFlag(parsed, "--connection")));
    if (optionalFlag(parsed, "--expected-origin") && optionalFlag(parsed, "--expected-origin") !== connection.origin || optionalFlag(parsed, "--expected-client") && optionalFlag(parsed, "--expected-client") !== connection.clientId) throw new Error("The private connection changed. Reload the plugin connection before continuing.");
    const input = JSON.parse(requiredFlag(parsed, "--input"));
    if (!input || typeof input !== "object" || Array.isArray(input)) usage("Input must be a JSON object.");
    return sharedRequest(connection, parsed.positionals[0]!, input);
  }
  if (command === "remote.pair") {
    const destination = resolve(requiredFlag(parsed, "--connection")), kind = optionalFlag(parsed, "--kind") ?? "agent";
    if (kind !== "agent" && kind !== "connector") usage("--kind must be agent or connector.");
    const qualify = optionalFlag(parsed, "--qualify-paths");
    if (qualify && !["yes", "no"].includes(qualify)) usage("--qualify-paths must be yes or no.");
    const machineOptions = { machineName: optionalFlag(parsed, "--machine-name"), ...(qualify ? { qualifyPaths: qualify === "yes" } : {}) };
    const origin = sharedOrigin(requiredFlag(parsed, "--origin"));
    const existing = await readSharedCredential(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      if (existing.origin !== origin) throw new Error("This connection already belongs to another hub. Choose a different private file.");
      // A file alone cannot establish whether its credential is still accepted.
      if (await credentialAccepted(existing)) return { enrolled: true, clientId: existing.clientId, machineId: existing.machineId, connection: destination };
      if (existing.machineId && optionalFlag(parsed, "--machine") && existing.machineId !== optionalFlag(parsed, "--machine")) throw new Error("Re-pair this connection with its retained machine identity.");
    }
    const pending = await readPending(`${destination}.pending`);
    if (pending) {
      if (pending.origin !== origin) throw new Error("A pairing for another hub is pending at this path.");
      if (pending.pair.expiresAt > Date.now()) return { pending: true, verificationUrl: pending.pair.verificationUrl, code: pending.pair.code, expiresAt: pending.pair.expiresAt, connection: destination };
      // Expired ceremonies cannot grant access; retain the chosen file-machine identity.
      const renewed = await beginSharedPairing(origin, requiredFlag(parsed, "--name"), kind, { ...machineOptions, machineId: optionalFlag(parsed, "--machine") ?? existing?.machineId ?? pending.pair.machineId ?? undefined });
      const temporary = `${destination}.pending.${crypto.randomUUID()}`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ origin, pair: renewed, replaces: existing?.clientId })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, `${destination}.pending`);
      return { pending: true, verificationUrl: renewed.verificationUrl, code: renewed.code, expiresAt: renewed.expiresAt, connection: destination };
    }
    const pair = await beginSharedPairing(origin, requiredFlag(parsed, "--name"), kind, { ...machineOptions, machineId: optionalFlag(parsed, "--machine") ?? existing?.machineId ?? undefined });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const file = await open(`${destination}.pending`, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ origin, pair, replaces: existing?.clientId })); await file.sync(); } finally { await file.close(); }
    return { verificationUrl: pair.verificationUrl, code: pair.code, expiresAt: pair.expiresAt, connection: destination, next: "Approve in the owner browser, then run tether remote complete --connection with this same file." };
  }
  if (command === "remote.complete") {
    const destination = resolve(requiredFlag(parsed, "--connection"));
    const pending = await readPending(`${destination}.pending`);
    if (!pending) {
      const installed = await readSharedCredential(destination);
      if (!await credentialAccepted(installed)) throw new Error("This connection needs re-pairing. Run remote pair with the same private file.");
      return { enrolled: true, clientId: installed.clientId, machineId: installed.machineId, connection: destination };
    }
    let credential = await pollSharedPairing(pending.origin, pending.pair);
    const waitSeconds = Number(optionalFlag(parsed, "--wait") ?? 0);
    if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) usage("--wait must be 0–300 seconds.");
    const deadline = Math.min(pending.pair.expiresAt, Date.now() + waitSeconds * 1000);
    while (!credential && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      credential = await pollSharedPairing(pending.origin, pending.pair);
    }
    if (!credential) return { pending: true, verificationUrl: pending.pair.verificationUrl, code: pending.pair.code };
    const existing = await readSharedCredential(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing && existing.clientId !== credential.clientId && (existing.clientId !== pending.replaces || await credentialAccepted(existing))) throw new Error("A different valid credential already exists. It has not been replaced.");
    if (!existing || existing.clientId !== credential.clientId) await writeSharedCredential(destination, credential);
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
