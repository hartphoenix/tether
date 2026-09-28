import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import contribute from "../integrations/paseo/index.server";
import { Hub } from "../integrations/paseo/server/hub";

const values = { tetherPath: "", profile: "preview", buttons: true };
const launch = { url: "http://127.0.0.1:1/recents/launch?ticket=test", expiresAt: Date.now() + 30_000 };
let start: ReturnType<typeof spyOn<Hub, "start">>;
let mint: ReturnType<typeof spyOn<Hub, "folioView">>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  start = spyOn(Hub.prototype, "start").mockImplementation(() => {});
  mint = spyOn(Hub.prototype, "folioView").mockResolvedValue(launch);
});
afterEach(() => { cleanup?.(); cleanup = undefined; start.mockRestore(); mint.mockRestore(); });

function setup(read: () => Promise<unknown> = async () => ({ status: "ready", values })) {
  const handlers = new Map<string, (input: any) => Promise<unknown>>();
  let update!: (state: any) => void;
  cleanup = contribute({
    registerSettings: () => ({ read, subscribe: (listener: typeof update) => { update = listener; return () => {}; } }),
    handle: (contract: { name: string }, handler: (input: any) => Promise<unknown>) => handlers.set(contract.name, handler),
    before: () => {},
  } as unknown as Parameters<typeof contribute>[0]);
  const call = (connection = values) => handlers.get("tether.folio-view")!({ workspaceId: "workspace-a", ...connection });
  return { handlers, call, update: (state: unknown) => update(state) };
}

test("Folio RPC registers synchronously but waits for ready settings", async () => {
  let resolve!: (value: unknown) => void;
  const server = setup(() => new Promise(done => { resolve = done; }));
  expect(server.handlers.has("tether.folio-view")).toBe(true);
  const pending = server.call();
  expect(mint).not.toHaveBeenCalled();
  resolve({ status: "ready", values });
  expect(await pending).toEqual(launch);
  expect(mint).toHaveBeenCalledWith("workspace-a");
});

test("failed and invalid settings never launch against defaults", async () => {
  const failed = setup(async () => { throw new Error("read failed"); });
  await expect(failed.call()).rejects.toThrow("settings are unavailable");
  cleanup?.();
  const invalid = setup(async () => ({ status: "invalid", error: "invalid" }));
  await expect(invalid.call()).rejects.toThrow("settings are unavailable");
  expect(mint).not.toHaveBeenCalled();
});

test("connection mismatches fail closed while button changes preserve Folio", async () => {
  const server = setup();
  await expect(server.call({ ...values, profile: "other" })).rejects.toThrow("settings changed");
  await expect(server.call({ ...values, tetherPath: "/other/tether" })).rejects.toThrow("settings changed");
  expect(mint).not.toHaveBeenCalled();
  server.update({ status: "ready", values: { ...values, buttons: false } });
  expect(await server.call()).toEqual(launch);
  server.update({ status: "invalid", error: "invalid" });
  await expect(server.call()).rejects.toThrow("settings are unavailable");
  expect(mint).toHaveBeenCalledTimes(1);
});

test("a settings update during a pending launch affects only subsequent requests", async () => {
  let resolve!: (value: typeof launch) => void;
  mint.mockImplementation(() => new Promise(done => { resolve = done; }));
  const server = setup();
  const pending = server.call();
  await Promise.resolve();
  await Promise.resolve();
  server.update({ status: "ready", values: { ...values, profile: "new-profile" } });
  await expect(server.call()).rejects.toThrow("settings changed");
  resolve(launch);
  expect(await pending).toEqual(launch);
  mint.mockResolvedValue(launch);
  expect(await server.call({ ...values, profile: "new-profile" })).toEqual(launch);
});
