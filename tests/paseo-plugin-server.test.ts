import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import contribute from "../integrations/paseo/index.server";
import { Hub } from "../integrations/paseo/server/hub";
import { tetherSettings } from "../integrations/paseo/shared/contracts";

const values = { tetherPath: "", profile: "preview", buttons: true };
const launch = { url: "http://127.0.0.1:1/recents/launch?ticket=test", expiresAt: Date.now() + 30_000 };
let start: ReturnType<typeof spyOn<Hub, "start">>;
let mint: ReturnType<typeof spyOn<Hub, "folioView">>;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  start = spyOn(Hub.prototype, "start").mockImplementation(() => {});
  mint = spyOn(Hub.prototype, "folioView").mockResolvedValue(launch);
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); start.mockRestore(); mint.mockRestore(); });

function setup(read: () => Promise<unknown> = async () => ({ status: "ready", values })) {
  const handlers = new Map<string, (input: any, context?: any) => Promise<any>>();
  let update!: (state: any) => void;
  const cleanup = contribute({
    registerSettings: () => ({ read, subscribe: (listener: typeof update) => { update = listener; return () => {}; } }),
    handle: (contract: { name: string }, handler: (input: any) => Promise<unknown>) => handlers.set(contract.name, handler),
    before: () => {},
  } as unknown as Parameters<typeof contribute>[0]);
  cleanups.push(cleanup);
  const call = (name: string, input: any) => handlers.get(`tether.${name}`)!(input, { paseo: {} });
  const pump = (generation: string | null = null, revision = -1) => call("pump", { revision, generation, executor: true });
  return { call, pump, cleanup, update: (state: unknown) => update(state) };
}

test("bootstrap waits for settings, returns a generation and accepts valid defaults", async () => {
  let resolve!: (value: unknown) => void;
  const server = setup(() => new Promise(done => { resolve = done; }));
  const pending = server.pump();
  expect(start).not.toHaveBeenCalled();
  resolve({ status: "ready", values: tetherSettings.schema.parse({}) });
  const { connection } = await pending;
  expect(connection).toMatchObject({ tetherPath: "", profile: "preview" });
  expect(await server.call("folio-view", { ...values, generation: connection.generation, workspaceId: "w" })).toEqual(launch);
});

test("failed and invalid settings publish unavailable state and reject every mutation", async () => {
  for (const read of [async () => { throw new Error("read failed"); }, async () => ({ status: "invalid" })]) {
    const server = setup(read);
    expect(await server.pump()).toMatchObject({ connection: null, folio: null, notices: {}, intents: [] });
    for (const name of ["open", "pin", "ack", "theme", "folio-view"]) await expect(server.call(name, { generation: "old" })).rejects.toThrow("settings are unavailable");
  }
  expect(start).not.toHaveBeenCalled();
  expect(mint).not.toHaveBeenCalled();
});

test("button updates preserve generation, invalidation clears it, and recovery restarts", async () => {
  const server = setup();
  const first = await server.pump();
  server.update({ status: "ready", values: { ...values, buttons: false } });
  expect(await server.pump()).toMatchObject({ connection: first.connection, buttons: false });
  expect(start).toHaveBeenCalledTimes(1);
  server.update({ status: "invalid" });
  expect((await server.pump()).connection).toBeNull();
  server.update({ status: "ready", values });
  expect((await server.pump()).connection.generation).not.toBe(first.connection.generation);
  expect(start).toHaveBeenCalledTimes(2);
});

test("subscription wins over a late initial read without waiting for it", async () => {
  let resolve!: (value: unknown) => void;
  const server = setup(() => new Promise(done => { resolve = done; }));
  server.update({ status: "ready", values: { ...values, profile: "new" } });
  expect((await server.pump()).connection.profile).toBe("new");
  resolve({ status: "ready", values });
  await Promise.resolve();
  expect((await server.pump()).connection.profile).toBe("new");
  expect(start).toHaveBeenCalledTimes(1);
});

test("cleanup during initial read never starts a Hub", async () => {
  let resolve!: (value: unknown) => void;
  const server = setup(() => new Promise(done => { resolve = done; }));
  server.cleanup();
  resolve({ status: "ready", values });
  expect((await server.pump()).connection).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

test("old generations, mismatched settings and old bundles cannot launch", async () => {
  const server = setup();
  const first = await server.pump();
  await expect(server.call("folio-view", { ...values, profile: "other", generation: first.connection.generation })).rejects.toThrow("settings changed");
  server.update({ status: "ready", values: { ...values, profile: "other" } });
  for (const name of ["open", "pin", "ack", "theme", "folio-view"]) await expect(server.call(name, { generation: first.connection.generation })).rejects.toThrow("settings changed");
  await expect(server.call("open", {})).rejects.toThrow("Reload Paseo");
  const legacyStart = Date.now();
  expect(await server.call("pump", { revision: 999, executor: true })).toMatchObject({ connection: null, intents: [], status: { error: expect.stringContaining("Reload Paseo") } });
  expect(Date.now() - legacyStart).toBeGreaterThanOrEqual(900);
  const next = await server.pump(first.connection.generation, 999999);
  expect(next.connection.profile).toBe("other");
  expect(mint).not.toHaveBeenCalled();
});

test("a pending launch cannot deliver an old-profile ticket after switching", async () => {
  let resolve!: (value: typeof launch) => void;
  mint.mockImplementation(() => new Promise(done => { resolve = done; }));
  const server = setup();
  const first = await server.pump();
  const pending = server.call("folio-view", { ...values, generation: first.connection.generation, workspaceId: "w" });
  await Promise.resolve();
  server.update({ status: "ready", values: { ...values, profile: "other" } });
  resolve(launch);
  await expect(pending).rejects.toThrow("may already have completed");
});
