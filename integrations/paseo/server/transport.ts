import type { FolioView, SharedReader } from "../shared/contracts";
import type { TetherRunner } from "./tether-cli";
import type { WaitBatch } from "./hub";

export type LibraryTransport = {
  pull(cursor: number, folio: number, timeout: number): Promise<WaitBatch>;
  acknowledge(ids: string[]): Promise<unknown>;
  list(): Promise<{ files: Array<Record<string, unknown>> }>;
  open(path: string, workspaceId: string): Promise<SharedReader | void>;
  pin(path: string, pinned: boolean): Promise<unknown>;
  theme(clientId: string, theme: string | null): Promise<unknown>;
  folio(workspaceId: string): Promise<FolioView>;
};

export function localTransport(run: TetherRunner): LibraryTransport {
  return {
    pull: (cursor, folio, timeout) => run(["paseo", "wait", "--after", String(cursor), "--folio", String(folio), "--timeout", String(timeout)]) as Promise<WaitBatch>,
    acknowledge: ids => run(["paseo", "ack", ...ids]),
    list: () => run(["folio", "list", "--view", "active", "--sort", "opened"]) as ReturnType<LibraryTransport["list"]>,
    open: async (path, workspaceId) => { await run(["open", path, "--host", "paseo"], { TETHER_PASEO_WORKSPACE_ID: workspaceId, TETHER_PASEO_ORIGIN: "user" }); },
    pin: (path, pinned) => run(["folio", "pin", path, ...(pinned ? [] : ["--off"])]),
    theme: (id, theme) => run(["paseo", "theme", id, theme ?? "unknown"]),
    folio: workspaceId => run(["folio", "--url", "--host", "paseo"], { TETHER_PASEO_WORKSPACE_ID: workspaceId, TETHER_PASEO_ORIGIN: "user" }) as Promise<FolioView>,
  };
}

/** Credential parsing and HTTPS stay in Tether; the plugin receives no bearer. */
export function sharedTransport(run: TetherRunner, connection: string): LibraryTransport {
  let binding: Promise<{clientId:string;origin:string}> | undefined;
  const call = async <T>(operation: string, input: object = {}): Promise<T> => {
    binding ??= run(["remote", "call", "plugin.connection", "--input", "{}", "--connection", connection]) as Promise<{clientId:string;origin:string}>;
    let expected: {clientId:string;origin:string};
    try { expected = await binding; } catch (cause) { binding = undefined; throw cause; }
    if (new URL(expected.origin).protocol !== "https:" || !expected.clientId) throw new Error("Invalid shared connection.");
    return run(["remote", "call", operation, "--input", JSON.stringify(input), "--connection", connection, "--expected-origin", expected.origin, "--expected-client", expected.clientId]) as Promise<T>;
  };
  const documentId = (path: string) => {
    if (!/^id:[a-f0-9-]{36}$/i.test(path)) throw new Error("Select a shared document by its ID.");
    return path.slice(3);
  };
  return {
    pull: (cursor, folio, timeout) => call("plugin.poll", { cursor, folio, timeout }),
    acknowledge: ids => call("reader.acknowledge", { ids }),
    list: () => call("folio.list", { view: "active", sort: "opened" }),
    open: path => call("plugin.open", { documentId: documentId(path) }),
    pin: (path, pinned) => call("folio.pin", { documentIds: [documentId(path)], pinned }),
    theme: (clientId, theme) => call("plugin.theme", { clientId, theme }),
    folio: workspaceId => call("plugin.folio", { workspaceId }),
  };
}
