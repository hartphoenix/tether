import { expect, test } from "bun:test";
import { hasOpener, lendOpener, runOrHold } from "../integrations/paseo/client/state";
import type { Intent } from "../integrations/paseo/shared/contracts";

const intent = (id: string): Intent => ({ id, url: `http://127.0.0.1:1/launch?ticket=${id}`, workspaceId: "w" });

test("intents wait for a Folio panel, open exactly once, and use the oldest panel", () => {
  const acked: string[] = [];
  const ack = (item: Intent) => { acked.push(item.id); };
  expect(hasOpener()).toBe(false);
  expect(runOrHold(intent("a"), ack)).toBe(false);
  expect(runOrHold(intent("a"), ack)).toBe(false); // A re-offer while waiting is not queued twice.

  const first: string[] = [];
  const second: string[] = [];
  const releaseFirst = lendOpener(item => { first.push(item.id); }, ack);
  const releaseSecond = lendOpener(item => { second.push(item.id); }, ack);
  expect(first).toEqual(["a"]);

  expect(runOrHold(intent("b"), ack)).toBe(true);
  expect(runOrHold(intent("b"), ack)).toBe(true); // A lapsed lease re-offers; no second tab.
  expect(first).toEqual(["a", "b"]);
  expect(second).toEqual([]);
  expect(acked).toEqual(["a", "b", "b"]);

  releaseFirst();
  runOrHold(intent("c"), ack);
  expect(second).toEqual(["c"]);
  releaseSecond();
  expect(hasOpener()).toBe(false);
});
