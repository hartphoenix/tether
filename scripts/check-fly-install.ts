import { lookup } from "node:dns/promises";
import { connect as tcp } from "node:net";
import { connect as tls } from "node:tls";
import { access, lstat, mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";
import { sharedOrigin } from "../src/remote/shared-auth";

type Check = { name: string; status: "ok" | "failed" | "cannot_check"; detail?: string };
export async function checkFlyInstall(options: { role: "service" | "connector" | "browser"; directory: string; origin?: string; paseo?: string }) {
  const checks: Check[] = [];
  const check = async (name: string, operation: () => Promise<unknown>) => {
    try { await operation(); checks.push({ name, status: "ok" }); }
    catch (cause) {
      const error = cause as { code?: string; message?: string };
      const restricted = ["EPERM", "EACCES"].includes(error.code ?? "");
      checks.push({ name, status: restricted ? "cannot_check" : "failed", detail: restricted ? "Cannot check from this environment." : error.code ?? error.message ?? "Check failed." });
    }
  };
  await check("runtime", async () => { if (Bun.version !== "1.3.9") throw new Error("The tested source runtime is Bun 1.3.9."); });
  await check("platform", async () => { if (!["darwin", "linux"].includes(process.platform)) throw new Error("This source installer supports macOS and Linux."); });
  if (options.role !== "browser") await check("private writable state", async () => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 }); const stat = await lstat(options.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Choose an owner-only directory.");
    const path = join(options.directory, `.write-check-${crypto.randomUUID()}`);
    await writeFile(path, "", { mode: 0o600, flag: "wx" }); await unlink(path);
  });
  if (options.role === "service") await check("diagram browser", async () => {
    const { chromium } = await import("playwright"); await access(chromium.executablePath(), constants.X_OK);
    const browser = await chromium.launch({ chromiumSandbox: true }); await browser.close();
  });
  if (options.role !== "browser") await check("supervisor", async () => {
    const args = process.platform === "darwin" ? ["launchctl", "print", `gui/${process.getuid!()}`] : ["systemctl", "--user", "show", "--property=Version"];
    // Never render supervisor environment output, even for an error.
    const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    if (await child.exited) throw new Error("Supervisor inspection failed; the service state is unknown.");
  });
  if (options.paseo) await check("Paseo plugin API", async () => {
    const child = Bun.spawn([options.paseo!, "--version"], { stdout: "pipe", stderr: "ignore" });
    const version = (await new Response(child.stdout).text()).trim();
    if (await child.exited || !/^0\.(?:9\.(?:[2-9]|\d{2,})|10\.\d+)$/.test(version)) throw new Error("Verify this Paseo revision against the plugin before installing.");
  });
  if (options.origin) {
    const url = new URL(sharedOrigin(options.origin)), port = Number(url.port || 443);
    await check("DNS", () => lookup(url.hostname));
    await check("TCP", () => new Promise<void>((resolve, reject) => {
      const socket = tcp({ host: url.hostname, port }); socket.setTimeout(5000);
      socket.once("connect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); socket.once("timeout", () => { socket.destroy(); reject(new Error("TCP timeout; network policy cannot be inferred from this alone.")); });
    }));
    await check("TLS", () => new Promise<void>((resolve, reject) => {
      const socket = tls({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: true }); socket.setTimeout(5000);
      socket.once("secureConnect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); socket.once("timeout", () => { socket.destroy(); reject(new Error("TLS timeout.")); });
    }));
    await check("Tether HTTPS sign-in", async () => {
      const response = await fetch(`${url.origin}/auth/login`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!response.ok || !(await response.text()).includes("Sign in to Tether")) throw new Error("HTTPS is reachable but Tether sign-in is not ready.");
    });
  }
  return { role: options.role, platform: process.platform, checks, ready: checks.every(check => check.status === "ok") };
}
if (import.meta.main) {
  const args = process.argv.slice(2), flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) flags.set(args[i]!, args[i + 1]!);
  const role = flags.get("--role");
  if (role !== "service" && role !== "connector" && role !== "browser") throw new Error("Choose --role service|connector|browser.");
  const result = await checkFlyInstall({ role, directory: resolve(flags.get("--directory") ?? "."), origin: flags.get("--origin"), paseo: flags.get("--paseo") });
  process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.ready ? 0 : 1;
}
