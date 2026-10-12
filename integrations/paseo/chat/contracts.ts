import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { parseChatRequest, type ChatState, type ChatRequest } from "./model";
const input = z.unknown().transform(value => parseChatRequest(value));
export const chatRpc = defineRpc({ name: "tether.chat", input, output: z.custom<ChatState>() });
export const reconcileRpc = defineRpc({ name: "tether.chat-reconcile", input: z.object({ generation: z.string().min(1).max(256), host: z.string().min(1).max(256), agent: z.string().min(1).max(256) }), output: z.object({ accepted: z.boolean(), state: z.custom<ChatState>() }) });
export type { ChatRequest };
