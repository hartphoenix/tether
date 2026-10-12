import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { TetherRunner } from "../server/tether-cli";
import { chatRpc, reconcileRpc } from "./contracts";
import type { ChatRequest, ChatState } from "./model";
import { hasCompletedReceipt } from "./receipts";

export function registerChat(server: PluginServerContext, run: (request: ChatRequest) => Promise<ChatState>) {
  server.handle(chatRpc, input => run(input));
  server.handle(reconcileRpc, async ({ generation, host, agent }) => {
    let state = await run({ generation, host, agent, operation: { kind: "read" } });
    const pending = state.submission;
    const raw = process.env.PASEO_HOME ?? "~/.paseo";
    const home = resolve(raw.startsWith("~/") ? `${homedir()}/${raw.slice(2)}` : raw);
    const accepted = !!pending && await hasCompletedReceipt(home, host, agent, pending);
    if (accepted) state = await run({ generation, host, agent, operation: { kind: "accepted", id: pending!.id, messageId: pending!.messageId! } });
    return { accepted, state };
  });
}
export async function runChat(run: TetherRunner, input: ChatRequest): Promise<ChatState> {
  return await run(["paseo", "chat", "-"], {}, JSON.stringify(input)) as ChatState;
}
