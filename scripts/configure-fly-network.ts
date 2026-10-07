import { resolveConfig } from "../src/server/config";
import { controlRequest } from "../src/server/lifecycle";

/** Agent-operated pilot adapter. It changes only the hub's dedicated HTTPS port. */
export async function configureFlyNetwork(attemptId: string, binary = "tailscale") {
  const config = resolveConfig();
  const state = await controlRequest<any>(config, "/control/shared/status", {});
  const attempt = state.attempts?.find((item: any) => item.id === attemptId);
  if (!attempt || attempt.expiresAt <= Date.now() || attempt.phase === "cancelled") throw new Error("Complete or resume the setup questions in local Settings first.");
  const url = new URL(state.origin), port = url.port || "443";
  if (!url.hostname.endsWith(".ts.net") || !["443", "8443", "10000"].includes(port)) throw new Error("Funnel needs a Tailscale hostname and HTTPS port 443, 8443, or 10000. Use a separately configured HTTPS proxy for another domain.");
  const command = async (args: string[], timeout = 15_000) => {
    const child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    } finally { clearTimeout(timer); }
  };
  const status = await command(["status", "--json"]);
  if (status.code) throw new Error("Cannot inspect Tailscale from this environment.");
  if (JSON.parse(status.stdout).Self?.DNSName?.replace(/\.$/, "") !== url.hostname) throw new Error("The configured origin belongs to another Tailscale machine.");
  const serve = await command(["serve", "status", "--json"]);
  if (serve.code) throw new Error("Cannot inspect existing HTTPS routes; no route has been changed.");
  const previous = JSON.parse(serve.stdout), target = `http://127.0.0.1:${state.localPort}`;
  for (const [host, web] of Object.entries(previous.Web ?? {}) as [string, any][]) {
    if (!host.endsWith(`:${port}`)) continue;
    if (host !== `${url.hostname}:${port}` || Object.keys(web.Handlers ?? {}).length !== 1 || web.Handlers?.["/"]?.Proxy !== target) throw new Error("That HTTPS port also serves another application. Choose a dedicated port before exposing it.");
  }
  const mode = attempt.answers.internet ? "funnel" : "serve";
  const result = await command([mode, "--bg", `--https=${port}`, target], 30_000);
  if (result.code) {
    const approval = `${result.stdout}\n${result.stderr}`.match(/https:\/\/(?:login|console)\.tailscale\.com\/[^\s]+/)?.[0];
    return { configured: false, phase: "awaiting external approval", ...(approval ? { approvalUrl: approval } : {}), message: "Approve the requested Tailscale change, return to Settings, and have the agent resume this same command." };
  }
  const verify = await command(["serve", "status", "--json"]);
  if (verify.code) throw new Error("Network configuration outcome is unconfirmed. Inspect the existing route before retrying.");
  const current = JSON.parse(verify.stdout);
  if (current.Web?.[`${url.hostname}:${port}`]?.Handlers?.["/"]?.Proxy !== target || !!current.AllowFunnel?.[`${url.hostname}:${port}`] !== attempt.answers.internet) throw new Error("The HTTPS route does not match the selected setup.");
  const response = await fetch(`${url.origin}/auth/login`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("The route is configured, but HTTPS sign-in is not yet reachable.");
  return { configured: true, internet: attempt.answers.internet, origin: url.origin, externalBrowserVerification: "pending" };
}
if (import.meta.main) {
  const args = process.argv.slice(2), index = args.indexOf("--attempt");
  if (index < 0 || !args[index + 1]) throw new Error("Usage: bun scripts/configure-fly-network.ts --attempt <owner-created-attempt-id>");
  process.stdout.write(JSON.stringify(await configureFlyNetwork(args[index + 1]!)) + "\n");
}
