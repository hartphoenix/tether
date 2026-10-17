import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(256);
const text = z.string().max(200_000);
export const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read") }),
  z.object({ kind: z.literal("save"), draft: z.object({ id, quote: text, feedback: text }) }),
  z.object({ kind: z.literal("capture"), id, prose: text, attachments: z.array(z.unknown()).max(100) }),
  z.object({ kind: z.literal("dispatch"), id, messageId: id, text, options: z.unknown() }),
  z.object({ kind: z.literal("accepted"), id, messageId: id }),
  z.object({ kind: z.literal("cancelPrepared"), id }),
]);
export const probeRpc = defineRpc({ name: "tether.delivery-probe", input: z.object({ host: id, agent: id, operation }), output: z.object({
  drafts: z.array(z.object({ id, quote: text, feedback: text })),
  submission: z.object({ id, prose: text, text, attachments: z.array(z.unknown()), draftIds: z.array(id), messageId: id.nullable(), wire: z.string().nullable(), state: z.enum(["prepared", "dispatching"]) }).nullable(),
}) });
export type ProbeState = z.infer<typeof probeRpc.output>;
export type Operation = z.infer<typeof operation>;
