import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HostTurnDelivery } from "./host-adapter";
import { hasCompletedReceipt } from "../../integrations/paseo/chat/receipts";
import { PASEO_API_SEND } from "./paseo-api";

export type PaseoTurnOptions = {
  env?: NodeJS.ProcessEnv;
  /** Test seam for the installed API runtime; production always uses Paseo's SDK. */
  apiCommand?: string[];
  commandTimeoutMs?: number;
  waitTimeoutMs?: number;
};

export class PaseoTurnDelivery implements HostTurnDelivery {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  constructor(private readonly options: PaseoTurnOptions = {}) {
    this.env = options.env ?? process.env;
    const home = this.env.PASEO_HOME ?? join(homedir(), ".paseo");
    this.home = resolve(home.startsWith("~/") ? join(homedir(), home.slice(2)) : home);
  }
  supports(agentId: string): boolean { return /^paseo:[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(agentId); }
  messageOptions(signalId: string) { return { messageId: signalId, activeTurnBehavior: "steer" }; }
  private id(agentId: string): string {
    if (!this.supports(agentId)) throw new Error("Invalid Paseo agent ID.");
    return agentId.slice(6);
  }
  chatScope(agentId: string): { host: string; agent: string } | undefined {
    if (!this.supports(agentId)) return undefined;
    // Use the selected local server's ID, never an arbitrary matching chat row.
    try {
      const host = readFileSync(join(this.home, "server-id"), "utf8").trim();
      if (!host) throw new Error("Empty Paseo server ID.");
      return { host, agent: this.id(agentId) };
    } catch { throw new Error("Cannot identify the local Paseo chat scope; annotations retained."); }
  }
  private cli(): string {
    return this.env.PASEO_CLI || Bun.which("paseo", { PATH: this.env.PATH }) || "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  }
  private async run(args: string[], signal: AbortSignal, timeoutMs = this.options.commandTimeoutMs ?? 30_000): Promise<any> {
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const child = Bun.spawn(args, { env: this.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const abort = () => child.kill("SIGKILL");
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) abort();
    try {
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      bounded.throwIfAborted();
      if (code !== 0) throw new Error("Paseo command failed; agent may be missing, archived, or unreachable. No replay attempted.");
      try { return JSON.parse(text); } catch { throw new Error("Paseo returned an invalid response. No replay attempted."); }
    } finally { bounded.removeEventListener("abort", abort); }
  }
  async inspect(agentId: string, signal: AbortSignal): Promise<"idle" | "running"> {
    const agent = await this.run([this.cli(), "inspect", this.id(agentId), "--json", "--home", this.home], signal);
    if (agent.Id !== this.id(agentId) || agent.Archived || agent.ArchivedAt) throw new Error("Paseo agent is missing or archived.");
    if (agent.PendingPermissions?.length) throw new Error("Paseo agent is waiting for permission.");
    if (agent.Status !== "idle" && agent.Status !== "running") throw new Error(`Paseo agent is unavailable (${String(agent.Status)}).`);
    return agent.Status;
  }
  async wait(agentId: string, signal: AbortSignal): Promise<void> {
    const timeout = this.options.waitTimeoutMs ?? 2 * 60 * 60_000;
    const result = await this.run([this.cli(), "wait", this.id(agentId), "--timeout", `${Math.ceil(timeout / 1000)}s`, "--json", "--home", this.home], signal, timeout + 5_000);
    if (result.status !== "idle") throw new Error(`Paseo wait ended with ${String(result.status)}; turn completion is unconfirmed.`);
  }
  async send(agentId: string, text: string, signalId: string, signal: AbortSignal): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "tether-paseo-turn-"));
    try {
      const prompt = join(directory, "prompt.txt"), script = join(directory, "send.cjs");
      await writeFile(prompt, text, { mode: 0o600 });
      await writeFile(script, PASEO_API_SEND, { mode: 0o600 });
      const resources = dirname(dirname(await realpath(this.cli())));
      const runtime = this.options.apiCommand ?? [join(resources, "../Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"),
        join(resources, "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js"), "node-script"];
      const args = [...runtime, script, join(resources, "app.asar/node_modules/@getpaseo/cli/dist/utils/client.js"), this.home, this.id(agentId), signalId, prompt];
      // The API explicitly uses steer as the final race guard. Normal busy
      // delivery remains queued until idle; it never requests interruption.
      while (true) {
        signal.throwIfAborted();
        const result = await this.runApi(args, signal);
        if (result.accepted === true) return;
        if (result.busy !== true) throw new Error("Paseo did not confirm acceptance.");
        await this.wait(agentId, signal);
      }
    } catch (error) {
      const scope = this.chatScope(agentId)!;
      if (await hasCompletedReceipt(this.home, scope.host, scope.agent, {
        id: signalId, prose: "", text, attachments: [], draftIds: [], state: "dispatching", messageId: signalId,
        wire: JSON.stringify({ text, options: this.messageOptions(signalId) }),
      })) return;
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private runApi(args: string[], signal: AbortSignal): Promise<any> {
    // The bundled helper requires this mode; do not mutate the daemon environment.
    const adapter = new PaseoTurnDelivery({ ...this.options, env: { ...this.env, ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production" } });
    return adapter.run(args, signal);
  }
}
