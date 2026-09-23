import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { resolveConfig } from "../src/server/config";
import { createDaemon, type TetherDaemon } from "../src/server/server";
import type { HostAdapter } from "../src/hosts/host-adapter";

// Establish actual committed state before checking the reporting contract.
describe.each(["open", "setup"] as const)("%s failure after completed work", (command) => {
  let root: string;
  let daemon: TetherDaemon;
  let result: Awaited<ReturnType<typeof runCli>>;
  let path: string;
  let ticketUrl: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp("/tmp/tether-partial-outcome-"));
    const config = resolveConfig({ runtimeDir: join(root, "runtime"), configDir: join(root, "config") });
    daemon = createDaemon({ config, startupGraceMs: 600_000, web: () => new Response("test") });
    await daemon.ready;
    path = join(root, "document.md");
    await writeFile(path, "# Partial outcome fixture\n");
    const host: HostAdapter = {
      id: "browser",
      detect: async () => true,
      capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: false }),
      openView: async request => {
        ticketUrl = request.url;
        throw Object.assign(new Error("Injected host placement failure"), { code: "placement_failed" });
      },
      openExternal: async () => {},
    };
    result = await runCli(command === "open" ? ["open", path] : ["setup", "--host", "browser"], { config, host, waveLaunchers: { widgetsPath: join(root, "absent-wave/widgets.json") } });
    // Establish that the intended failure boundary was reached.
    expect(result).toMatchObject({ exitCode: 1, response: { ok: false, error: { code: "placement_failed" } } });
    const listing = await runCli(["folio", "list"], { config });
    expect(listing.response.ok).toBe(true);
    if (!listing.response.ok) throw new Error("Fixture registry could not be inspected");
    const files = (listing.response.data as { files: Array<{ path: string }> }).files;
    if (command === "setup") {
      expect(JSON.parse(await readFile(join(config.configDir, "launch.json"), "utf8"))).toEqual({ host: "browser" });
      expect(files).toHaveLength(1);
      path = files[0]!.path;
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
    } else expect(files.some(file => file.path === path)).toBe(true);
  });

  afterAll(async () => {
    await daemon?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("placement failure cancels the unused launch credential", async () => {
    expect((await fetch(ticketUrl, { redirect: "manual" })).status).toBe(401);
    expect(JSON.stringify(result.response)).not.toContain(new URL(ticketUrl).searchParams.get("ticket")!);
  });

  test("reports the original command and committed effect despite placement failure", () => {
    expect(result.response).toMatchObject({ command, ok: false, error: { details: { outcome: "partially_applied" } } });
    expect(JSON.stringify(result.response)).toContain(path);
  });
});
