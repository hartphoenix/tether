import { expect, mock, test } from "bun:test";
import { acceptBatch, disconnect, getState, lendOpener, setState } from "../integrations/paseo/client/state";
import type { PumpBatch } from "../integrations/paseo/shared/contracts";
// Native platform detection is irrelevant to this pump test; mounted openers supply capability.
mock.module("../integrations/paseo/client/web", () => ({ isDesktop: () => false }));
// Keep React Native globals out of the root DOM typecheck; the plugin has its own tsc check.
const pumpModule = "../integrations/paseo/client/pump";
const { startPump } = await import(pumpModule) as { startPump: (client: { rpc: (contract: { name: string }, input: unknown) => Promise<unknown> }) => () => void };
const tick = () => Bun.sleep(5);
const batch = (generation: string, daemon: string, revision: number): PumpBatch => ({
  connection: { generation, tetherPath: "", profile: generation }, revision, folio: [], notices: {}, intents: [], buttons: true,
  status: { connected: true, tether: daemon, error: null },
});

test("client pump bootstraps, changes generations, and clears stale state after RPC failure", async () => {
  disconnect();
  setState({ query: "keep filter", scope: "all" });
  const calls: any[] = [];
  let resolve!: (value: PumpBatch) => void;
  let reject!: (cause: Error) => void;
  const stop = startPump({
    rpc: (_contract: unknown, input: unknown) => {
      calls.push(input);
      return new Promise<PumpBatch>((done, fail) => { resolve = done; reject = fail; });
    },
  } as unknown as Parameters<typeof startPump>[0]);
  try {
    expect(calls[0]).toMatchObject({ generation: null, revision: -1 });
    resolve(batch("A", "daemon-A", 100)); await tick();
    expect(calls[1]).toMatchObject({ generation: "A", revision: 100 });
    resolve(batch("B", "daemon-B", 1)); await tick();
    expect(calls[2]).toMatchObject({ generation: "B", revision: 1 });
    reject(new Error("transport failure")); await tick();
    expect(getState()).toMatchObject({ connection: null, folio: null, notices: {}, query: "keep filter", scope: "all" });
    await Bun.sleep(1050);
    expect(calls[3]).toMatchObject({ generation: null, revision: -1 });
    stop(); resolve(batch("late", "late", 5)); await tick();
    expect(getState().connection).toBeNull();
  } finally { stop(); }
});

test("pump acknowledgements keep the generation of the delivered intent", async () => {
  disconnect();
  const acknowledgements: any[] = [];
  const opened: string[] = [];
  const release = lendOpener(intent => opened.push(intent.id), () => {});
  let next!: (value: PumpBatch) => void;
  let first = true;
  const stop = startPump({
    rpc: (contract: { name: string }, input: unknown) => {
      if (contract.name === "tether.ack") { acknowledgements.push(input); return Promise.resolve({ acknowledged: 1 }); }
      if (first) {
        first = false;
        return Promise.resolve({ ...batch("A", "daemon-A", 1), intents: [{ id: "open", workspaceId: "w", url: "http://127.0.0.1:1/launch?ticket=test" }] });
      }
      return new Promise<PumpBatch>(resolve => { next = resolve; });
    },
  } as unknown as Parameters<typeof startPump>[0]);
  try {
    await tick();
    expect(opened).toEqual(["open"]);
    expect(acknowledgements).toEqual([{ ids: ["open"], generation: "A" }]);
    acceptBatch(batch("B", "daemon-B", 0));
  } finally { stop(); release(); next(batch("B", "daemon-B", 0)); await tick(); }
});
