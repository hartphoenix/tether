import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";

const directories: string[] = [];
const daemons: TetherDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("returns one versioned open result without exposing the launch ticket", async () => {
  const directory = await mkdtemp(join("/tmp", "tether-cli-"));
  directories.push(directory);
  const path = join(directory, "example.md");
  await writeFile(path, "Example\n");
  const config = resolveConfig({ profile: "test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("web") });
  daemons.push(daemon);
  await daemon.ready;
  const opened: string[] = [];
  const result = await runCli(["open", path], { config, open: async (url) => { opened.push(url); } });
  expect(result.exitCode).toBe(0);
  expect(result.response).toEqual({
    protocol: 1,
    ok: true,
    command: "open",
    data: { path: await realpath(path), expiresAt: expect.any(Number), opened: true },
  });
  expect(JSON.stringify(result.response)).not.toContain("ticket");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("/launch?ticket=");
});

test("uses a documented structured usage failure", async () => {
  const result = await runCli(["unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.response).toMatchObject({ protocol: 1, ok: false, command: "unknown", error: { code: "usage" } });
});
