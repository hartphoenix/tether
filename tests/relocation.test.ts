import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrivateStore } from "../src/storage/private-store";
import { resolveConfig, prepareConfig } from "../src/server/config";
import { writeSharedConfig, readSharedConfig } from "../src/server/shared-profile";
import { assertAuthority, relocate } from "../src/cli/relocation";
import { restoreState } from "../src/cli/backup";
import { SharedAuth } from "../src/remote/shared-auth";
import { SetupAttempts } from "../src/remote/setup-attempts";

test.each([false, true])("relocation (existing destination: %s) resumes a fenced backup, requires release, retains file identity, and forbids late rollback", async (existing) => {
  const directory = await mkdtemp("/tmp/tether-relocate-");
  const source = resolveConfig({ configDir: join(directory, "source"), runtimeDir: join(directory, "runtime") });
  try {
    await prepareConfig(source);
    const store = new PrivateStore(join(source.configDir, "tether.sqlite"));
    const machineId = store.localMachineId, document = store.ensureDocument(join(directory, "document.md"));
    const destinationId = crypto.randomUUID();
    const destinationDocument = store.ensureDocument(join(directory, "destination.md"));
    store.machines.set(destinationId, "new hub");
    store.db.query("UPDATE documents SET machine_id=? WHERE id=?").run(destinationId, destinationDocument.id);
    const attempt = new SetupAttempts(store.db).save({ hub: "new hub", machine: "", access: "browser", qualifyPaths: false, internet: false, relocate: true, ...(existing ? { machineId: destinationId } : {}) });
    new SharedAuth({ db: store.db, origin: "https://old.example.test", passkeys: { enrolled: () => false, registrationOptions: async () => { throw 0; }, authenticationOptions: async () => { throw 0; }, register: async () => {}, authenticate: async () => {} } });
    store.close();
    await writeSharedConfig(source, { origin: "https://old.example.test", port: 18420, owner: "Owner", active: true });
    const input = { output: join(directory, "backup"), destination: "new hub", attemptId: attempt.id };
    const prepared = await relocate(source, "prepare", input);
    expect(await relocate(source, "prepare", input)).toEqual(prepared);
    await expect(assertAuthority(source)).rejects.toThrow("fenced");
    const destination = resolveConfig({ configDir: join(directory, "destination"), runtimeDir: join(directory, "destination-runtime") });
    await restoreState(input.output, destination.configDir);
    expect((await readSharedConfig(destination))?.active).toBe(false);
    const receipt = join(directory, "receipt.json");
    const wrong = join(directory, "unrelated.json");
    await writeFile(wrong, JSON.stringify({ id: prepared.transferId, secret: "not-released" }), { mode: 0o600 });
    await expect(relocate(destination, "activate", { receipt: wrong })).rejects.toThrow("does not release");
    await expect(relocate(source, "release", { output: wrong })).rejects.toThrow("another file");
    await relocate(source, "release", { output: receipt });
    await relocate(source, "release", { output: receipt });
    await expect(relocate(source, "rollback", {})).rejects.toThrow("irreversible");
    await relocate(destination, "activate", { receipt });
    const copy = new PrivateStore(join(destination.configDir, "tether.sqlite"));
    const activatedId = copy.localMachineId;
    expect(activatedId).not.toBe(machineId);
    if (existing) expect(activatedId).toBe(destinationId);
    expect(copy.documentById(destinationDocument.id)?.machine_id).toBe(destinationId);
    expect(copy.documentById(document.id)?.machine_id).toBe(machineId);
    expect(new SetupAttempts(copy.db).get(attempt.id).phase).toBe("awaiting verification");
    copy.close();
    await relocate(destination, "activate", { receipt });
    const resumed = new PrivateStore(join(destination.configDir, "tether.sqlite"));
    expect(resumed.localMachineId).toBe(activatedId); resumed.close();
    await expect(assertAuthority(source)).rejects.toThrow("fenced");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rollback before release leaves the source identity intact", async () => {
  const directory = await mkdtemp("/tmp/tether-relocate-rollback-");
  const config = resolveConfig({ configDir: join(directory, "config"), runtimeDir: join(directory, "runtime") });
  try {
    await prepareConfig(config);
    const store = new PrivateStore(join(config.configDir, "tether.sqlite")), id = store.localMachineId; store.close();
    await relocate(config, "prepare", { output: join(directory, "backup"), destination: "other" });
    await relocate(config, "rollback", {}); await assertAuthority(config);
    const copy = new PrivateStore(join(config.configDir, "tether.sqlite")); expect(copy.localMachineId).toBe(id); copy.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
