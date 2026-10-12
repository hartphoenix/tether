import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemon } from "../src/server/server";
import { resolveConfig } from "../src/server/config";
import { runCli } from "../src/cli/main";
import { controlRequest } from "../src/server/lifecycle";

test("chat CLI uses authenticated owning daemon and survives daemon restart", async () => {
  const root = await mkdtemp("/tmp/tether-chat-service-v1-");
  const config = resolveConfig({ profile: "test", runtimeDir: join(root, "runtime"), configDir: join(root, "config") });
  let daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
  try {
    const input = { host: "fixture-host", agent: "fixture-agent", operation: { kind: "save", draft: { id: "draft", quote: "quoted", feedback: "" } } };
    const file = join(root, "request.json"); await writeFile(file, JSON.stringify(input));
    const denied = await fetch(`${daemon.origin}/control/chat`, { method: "POST", body: JSON.stringify(input) });
    expect(denied.status).toBe(403);
    const result = await runCli(["paseo", "chat", file], { config });
    expect(result.response.ok).toBe(true);
    await daemon.stop(); daemon = createDaemon({ config, startupGraceMs: 600_000 }); await daemon.ready;
    const recovered = await controlRequest<any>(config, "/control/chat", { ...input, operation: { kind: "read" } });
    expect(recovered.drafts).toEqual([input.operation.draft]);
    await controlRequest(config, "/control/chat", { ...input, operation: { kind: "deleteChat" } });
    await expect(controlRequest(config, "/control/chat", input)).rejects.toThrow("permanently deleted");
  } finally { await daemon.stop(); await rm(root, { recursive: true, force: true }); }
});
