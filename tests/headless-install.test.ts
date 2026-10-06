import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessAssets, installHeadless } from "../scripts/install-headless";

describe("headless source installation", () => {
  test("supervisors preserve paths and launch foreground roles", () => {
    const input = { role: "connector" as const, platform: "linux" as const, checkout: "/source", directory: '/deployment with "quotes"/$home%/connector', bun: "/runtime/bun", profile: "shared", connection: "/private/connection.json" };
    const linux = headlessAssets(input);
    expect(linux.unit).toContain('ExecStart="/deployment with \\"quotes\\"/$$home%%/connector/run"');
    expect(linux.script).toContain("'connector' 'run' '--connection' '/private/connection.json'");
    expect(linux.unit).toContain("UMask=0077");
    const mac = headlessAssets({ ...input, platform: "darwin" });
    expect(mac.unit).toContain("&quot;quotes&quot;");
    expect(mac.unit).toContain("<key>KeepAlive</key><true/>");
    const service = headlessAssets({ ...input, role: "service", connection: undefined });
    expect(service.script).toContain("'/source/src/server/daemon.ts'");
    expect(service.script).not.toContain("'connector'");
  });

  test("refuses invalid roles, control characters, and missing credentials", () => {
    const input = { role: "connector" as const, platform: "linux" as const, checkout: "/source", directory: "/output", bun: "/bun", profile: "shared" };
    expect(() => headlessAssets(input)).toThrow("--connection");
    expect(() => headlessAssets({ ...input, role: "service", profile: "bad\nprofile" })).toThrow();
    expect(() => headlessAssets({ ...input, role: "service", directory: "/bad\npath" })).toThrow();
  });

  test("installs private assets and executes unusual paths without shell expansion", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "tether-headless-install-")));
    try {
      const checkout = join(scratch, "source ' $literal`path`"), directory = join(scratch, "installed"), runtime = join(scratch, "bun stub");
      await mkdir(join(checkout, "src/server"), { recursive: true });
      await mkdir(join(checkout, "src/cli"), { recursive: true });
      await mkdir(join(checkout, "node_modules/typescript"), { recursive: true });
      for (const file of ["src/server/daemon.ts", "src/cli/public.ts", "node_modules/typescript/package.json"]) await writeFile(join(checkout, file), "");
      const argumentsPath = join(scratch, "arguments"), profilePath = join(scratch, "profile");
      await writeFile(runtime, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argumentsPath}'\nprintf '%s' "$TETHER_PROFILE" > '${profilePath}'\n`, { mode: 0o700 });
      await chmod(runtime, 0o700);
      const connection = join(scratch, "private '$credential`.json");
      const result = await installHeadless({ role: "connector", platform: process.platform === "darwin" ? "darwin" : "linux", checkout, directory, bun: runtime, profile: "shared", connection });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(result.launcher)).mode & 0o777).toBe(0o700);
      expect((await stat(result.unit)).mode & 0o777).toBe(0o600);
      const child = Bun.spawn([result.launcher], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect((await readFile(argumentsPath, "utf8")).split("\0")).toEqual(["--no-env-file", join(checkout, "src/cli/public.ts"), "connector", "run", "--connection", connection, ""]);
      expect(await readFile(profilePath, "utf8")).toBe("shared");
      if (process.platform === "darwin") {
        const plist = Bun.spawn(["/usr/bin/plutil", "-lint", result.unit], { stdout: "pipe", stderr: "pipe" });
        expect(await plist.exited).toBe(0);
      }
      await expect(installHeadless({ role: "service", platform: "linux", checkout, directory, bun: runtime, profile: "shared" })).rejects.toMatchObject({ code: "EEXIST" });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
