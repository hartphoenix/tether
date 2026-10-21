import { expect, mock, test } from "bun:test";
import { acceptBatch } from "../integrations/paseo/client/state";
import { Hub } from "../integrations/paseo/server/hub";

mock.module("../integrations/paseo/client/theme-mark", () => ({ ThemeMark: () => null }));
mock.module("../integrations/paseo/client/web", () => ({ isDesktop: () => true }));
// The plugin has its own typecheck; keep its native UI types out of the root check.
const headerModule = "../integrations/paseo/client/header-buttons";
const { startHeaderButtons } = await import(headerModule) as { startHeaderButtons(client: unknown): () => void };

test("acknowledging an existing reader clears the staged button and its next click opens Folio", async () => {
  const path = "/docs/existing.md", documentId = crypto.randomUUID();
  let intents: unknown[] = [{ id: "notice", seq: 1, path, kind: "document", origin: "agent", target: { workspaceId: "ws" }, expiresAt: Date.now() + 30_000 }];
  const hub = new Hub({
    connection: { generation: "header-test", tetherPath: "", profile: "test" },
    run: async args => {
      if (args[1] === "wait") return { cursor: 2, folio: 0, intents, instanceId: "header-test" };
      if (args[1] === "list") return { files: [{ path, id: documentId, openedAt: 1 }] };
      return {};
    },
  });
  await hub.pullOnce();
  acceptBatch(await hub.pump(-1, false));
  let button!: { label?: string; title: string; behavior: { onPress(): void } };
  const panels: unknown[] = [], requests: unknown[] = [];
  const stop = startHeaderButtons({
    paseo: { workspaces: { list: async () => ({ subscription: {
      subscribe: (handlers: { snapshot(value: unknown): void }) => handlers.snapshot({ entries: [{ id: "ws" }] }),
      release: async () => {},
    } }) } },
    addHeaderButton: (registration: { button: typeof button }) => {
      button = registration.button;
      return { update: (next: typeof button) => { button = next; }, remove: () => {} };
    },
    openPanel: (...args: unknown[]) => panels.push(args),
    rpc: async (...args: unknown[]) => { requests.push(args); },
  });
  try {
    await Promise.resolve();
    expect(button.label).toBe("existing");
    button.behavior.onPress();
    expect(requests).toHaveLength(1);
    expect(panels).toEqual([]);
    // The existing reader accepts the launch without loading a new session or updating openedAt.
    intents = [{ id: "launch", seq: 2, path, documentId, url: "http://127.0.0.1:1234/launch?ticket=test", kind: "document", origin: "user", target: { workspaceId: "ws" }, expiresAt: Date.now() + 30_000 }];
    await hub.pullOnce();
    await hub.ack(["launch"]);
    acceptBatch(await hub.pump(-1, false));
    expect(button.label).toBeUndefined();
    expect(button.title).toBe("Tether Folio");
    button.behavior.onPress();
    expect(panels).toEqual([["folio", { workspaceId: "ws", location: "explorer" }]]);
    expect(requests).toHaveLength(1);
  } finally { stop(); hub.stop(); }
});
