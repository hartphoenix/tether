import { expect, test } from "bun:test";
import { createReaderReceiver, createSharedReaderLink, assertSharedReaderLink } from "../src/remote/reader-receiver";
import { PaseoHostAdapter } from "../src/hosts/paseo";
import type { HostAdapter } from "../src/hosts/host-adapter";
import type { PullIntentInput } from "../src/hosts/pull-queue";

const origin = "https://reader.example", documentId = "11111111-1111-4111-8111-111111111111";
const url = `${origin}/reader/d/${documentId}/`;
const item = { id: crypto.randomUUID(), documentId, url, origin: "agent" as const, expiresAt: 2000 };

test("shared reader capability is bound to exact configured origin, document and credential-free route", () => {
  const reader = createSharedReaderLink(origin, documentId, url);
  expect(() => assertSharedReaderLink(reader)).not.toThrow();
  expect(Object.isFrozen(reader)).toBe(true);
  expect(() => assertSharedReaderLink({ ...reader })).toThrow("capability");
  for (const bad of [url + "?token=secret", url + "#target", url.replace("reader.example", "other.example"), url.replace("https:", "http:"), url.replace("reader.example", "user:pass@reader.example"), `${origin}/folio/`, url.replace(documentId, crypto.randomUUID())]) {
    expect(() => createSharedReaderLink(origin, documentId, bad)).toThrow();
  }
  expect(() => createSharedReaderLink(`${origin}/unexpected`, documentId, url)).toThrow();
});

test("Paseo reception captures the local workspace once and queues only an agent notice", async () => {
  const sent: PullIntentInput[] = [], env = { TETHER_PASEO_WORKSPACE_ID: "original" };
  const host = new PaseoHostAdapter({ env, enqueue: async input => { sent.push(input); } });
  const receiver = createReaderReceiver({ origin, host, now: () => 1000 });
  env.TETHER_PASEO_WORKSPACE_ID = "changed";
  expect(await receiver.deliver({ ...item, host: "cmux" })).toEqual({ host: "paseo", placement: "announced", nativePlacement: "supported" });
  expect(sent).toEqual([{ kind: "document", origin: "agent", sharedReader: { origin, documentId, url }, target: { host: "paseo", workspaceId: "original" } }]);
  await expect(receiver.deliver({ ...item, expiresAt: 999 })).rejects.toThrow("expired");
  await expect(receiver.deliver({ ...item, url: `${url}?ticket=secret` })).rejects.toThrow();
  expect(sent).toHaveLength(1);
});

test("unsupported or unavailable hosts retain the public link without invoking a focus-changing fallback", async () => {
  let opened = 0;
  const host: HostAdapter = { id: "wave", detect: async () => true, launchTarget: () => ({ host: "wave", tabId: "scratch" }),
    capabilities: () => ({ embeddedBrowser: true, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: false }),
    openView: async () => { opened++; }, openExternal: async () => { opened++; } };
  expect(await createReaderReceiver({ origin, host, now: () => 1000 }).deliver(item)).toMatchObject({ placement: "link_available", nativePlacement: "unsupported" });
  host.receiveReader = async () => { throw Object.assign(new Error("private host detail"), { code: "host_not_connected" }); };
  expect(await createReaderReceiver({ origin, host, now: () => 1000 }).deliver(item)).toMatchObject({ placement: "link_available", nativePlacement: "failed", reason: "host_not_connected" });
  expect(opened).toBe(0);
});
