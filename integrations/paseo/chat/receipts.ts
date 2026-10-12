import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Submission } from "./model";

/** Read-only adapter for Paseo 0.11.2's durable receipts. Never retries a send. */
export function receiptDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, candidate) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b))) : candidate)).digest("hex");
}
export function receiptRequest(wire: string): unknown {
  const { text, options } = JSON.parse(wire);
  if (typeof text !== "string" || !options) throw new Error("Missing dispatch payload.");
  const images: { data: string; mimeType: string }[] = options.images ?? [];
  const attachments: Record<string, unknown>[] = options.attachments ?? [];
  const history = attachments.filter(a => a.type === "text" && a.contextKind === "chat_history");
  const others = attachments.filter(a => !(a.type === "text" && a.contextKind === "chat_history"));
  const prompt = images.length || attachments.length ? [...history, ...(text.trim() ? [{ type: "text", text: text.trim() }] : []), ...images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })), ...others] : text.trim();
  return { prompt, activeTurnBehavior: options.activeTurnBehavior ?? "interrupt" };
}
export async function hasCompletedReceipt(home: string, host: string, agent: string, submission: Submission): Promise<boolean> {
  if (!submission.messageId || !submission.wire || submission.state !== "dispatching") return false;
  try {
    // A remote host's receipt must never be inferred from this daemon's files.
    if ((await readFile(join(home, "server-id"), "utf8")).trim() !== host) return false;
    const key = receiptDigest(["send", agent, submission.messageId]);
    const receipt = JSON.parse(await readFile(join(home, "agent-requests", `${key}.json`), "utf8"));
    return receipt.state === "completed" && receipt.agentId === agent && receipt.fingerprint === receiptDigest(receiptRequest(submission.wire));
  } catch { return false; } // Missing, unreadable or changed receipts are uncertainty, never rejection.
}
