import { expect, test } from "bun:test";
import { sharedTransport } from "../integrations/paseo/server/transport";

test("shared Paseo transport binds every call to the same private connection and uses document IDs", async () => {
  const calls: string[][] = [];
  const transport = sharedTransport(async args => {
    calls.push(args);
    if (args[2] === "plugin.connection") return { clientId: "client", libraryId: "library", origin: "https://hub.example" };
    return {};
  }, "/private/connection.json");
  const id = crypto.randomUUID();
  await transport.pull(0, -1, 20); await transport.open(`id:${id}`, "workspace"); await transport.pin(`id:${id}`, true);
  expect(calls.filter(args => args[2] === "plugin.connection")).toHaveLength(1);
  for (const args of calls.slice(1)) {
    expect(args).toContain("--expected-client"); expect(args).toContain("client");
    expect(args).toContain("--expected-origin"); expect(args).toContain("https://hub.example");
  }
  expect(JSON.parse(calls[2]![4]!)).toEqual({ documentId: id });
  expect(() => transport.open("/remote/file.md", "workspace")).toThrow("document by its ID");
});
