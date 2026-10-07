import { expect, test } from "bun:test";
import { acceptBatch, hasOpener, lendOpener, runOrHold, sourceKey, type Delivery } from "../integrations/paseo/client/state";
import type { Intent } from "../integrations/paseo/shared/contracts";
import { intentBrowserUrl } from "../integrations/paseo/client/theme-sync";

const intent = (id: string): Delivery => ({ generation: "g1", source: sourceKey(), id, url: `http://127.0.0.1:1/launch?ticket=${id}`, workspaceId: "w" });

test("public reader intents retain their credential-free authenticated URL without local launch parameters", () => {
  const documentId = crypto.randomUUID(), origin = "https://reader.example", url = `${origin}/reader/d/${documentId}/`;
  const publicIntent = { id: "shared", workspaceId: "w", url, sharedReader: { origin, documentId, url } };
  expect(intentBrowserUrl(publicIntent)).toStartWith(url + "?themeClient=");
  expect(() => intentBrowserUrl({ ...publicIntent, url: "https://unrelated.example/" })).toThrow("Mismatched");
  expect(() => intentBrowserUrl({ ...publicIntent, sharedReader: { ...publicIntent.sharedReader, url: url + "?token=secret" } })).toThrow();
  expect(() => intentBrowserUrl({ id: "untrusted", workspaceId: "w", url })).toThrow("Invalid Tether launch");
});

test("intents wait for a Folio panel, open exactly once, and use the oldest panel", () => {
  acceptBatch({ connection: { generation: "g1", tetherPath: "", profile: "preview" }, revision: 0, folio: [], notices: {}, intents: [], buttons: true, status: { connected: true, tether: "daemon", error: null } });
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

test("connection transitions drop waiting launches and preserve same-daemon duplicate suppression", () => {
  const batch = (generation: string, profile: string, daemon: string) => ({ connection: { generation, tetherPath: "", profile }, revision: 0, folio: [], notices: {}, intents: [], buttons: true, status: { connected: true, tether: daemon, error: null } });
  acceptBatch(batch("a1", "A", "daemon-A"));
  const waiting = { ...intent("waiting"), generation: "a1" };
  expect(runOrHold(waiting, () => {})).toBe(false);
  acceptBatch(batch("b1", "B", "daemon-B"));
  const opened: string[] = [];
  const acknowledged: string[] = [];
  const ack = (delivery: Delivery) => { acknowledged.push(delivery.generation); };
  const release = lendOpener(delivery => { opened.push(delivery.id); }, ack);
  expect(opened).toEqual([]);
  // A late callback from A cannot open or acknowledge a launch against B.
  runOrHold(waiting, ack);
  expect(acknowledged).toEqual([]);
  acceptBatch(batch("a2", "A", "daemon-A"));
  const first = { ...intent("lost-ack"), generation: "a2" };
  runOrHold(first, ack);
  acceptBatch(batch("b2", "B", "daemon-B"));
  acceptBatch(batch("a3", "A", "daemon-A"));
  runOrHold({ ...first, generation: "a3" }, ack);
  expect(opened).toEqual(["lost-ack"]);
  expect(acknowledged).toEqual(["a2", "a3"]);
  // A new daemon may reuse an ID; its namespace is different.
  acceptBatch(batch("a3", "A", "daemon-A-restarted"));
  runOrHold({ ...intent("lost-ack"), generation: "a3" }, ack);
  expect(opened).toEqual(["lost-ack", "lost-ack"]);
  release();
});
