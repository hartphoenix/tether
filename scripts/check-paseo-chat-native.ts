/** Execute the relevant unmodified functions from a pinned Paseo source checkout. */
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { queuedBatch, stripBatchCarrier } from "../integrations/paseo/chat/queue";
import { hasCompletedReceipt } from "../integrations/paseo/chat/receipts";
const source = process.argv[2] ?? "/tmp/tether-paseo-v0112-probe";
const revision = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]);
assert.equal(revision.stdout.toString().trim(), "75953250959979b8f088bbca8dbd6ee61d0151b1", "Use the reviewed Paseo 0.11.2 checkout.");
const scratch = await mkdtemp("/tmp/tether-chat-native-");
function functionSource(source: string, start: string, end: string) { const begin = source.indexOf(start); const finish = source.indexOf(end, begin); assert.ok(begin >= 0 && finish > begin); return source.slice(begin, finish); }
try {
  await symlink(resolve("integrations/paseo/node_modules"), join(scratch, "node_modules"));
  await mkdir(join(scratch, "receipts"));
  await cp(join(source, "packages/server/src/server/message-receipts/index.ts"), join(scratch, "receipts/index.ts"));
  await cp(join(source, "packages/server/src/server/atomic-file.ts"), join(scratch, "atomic-file.ts"));
  const attachmentSource = await readFile(join(source, "packages/app/src/composer/attachments/submit.ts"), "utf8");
  const workspaceSource = await readFile(join(source, "packages/app/src/attachments/workspace-attachment-utils.ts"), "utf8");
  const actions = await readFile(join(source, "packages/app/src/composer/actions.ts"), "utf8");
  const promptSource = await readFile(join(source, "packages/server/src/server/agent/prompt-attachments.ts"), "utf8");
  // Remove type-only imports; unused forge/resource paths explicitly fail if invoked.
  const workspace = workspaceSource.slice(workspaceSource.indexOf("export function isPullRequestContextAttachment"));
  const split = attachmentSource.slice(attachmentSource.indexOf("export function splitComposerAttachmentsForSubmit"));
  const dispatch = functionSource(actions, "export async function dispatchComposerAgentMessage", "export interface QueueComposerMessageInput");
  // Find the next declaration after the function's opening, rather than its own export.
  const sendStart = actions.indexOf("export async function sendQueuedComposerMessageNow");
  const sendEnd = actions.indexOf("\nexport ", sendStart + 1);
  await writeFile(join(scratch, "native.ts"), `const unavailable=()=>{throw Error('Unexpected attachment branch')}; const buildLegacyGitHubAttachmentFromSearchItem=unavailable, buildForgeAttachmentFromSearchItem=unavailable, workspaceFileAttachmentToAgentAttachment=unavailable, pluginResourceAttachmentToAgentAttachment=unavailable; const generateMessageId=()=>crypto.randomUUID(); const createUserMessage=(x:any)=>x; const i18n={t:(x:string)=>x};\n${workspace}\n${split}\n${dispatch}\n${actions.slice(sendStart, sendEnd)}\n${functionSource(promptSource, "export function buildAgentPrompt", "export function renderPromptAttachmentAsText")}`);
  const native = await import(join(scratch, "native.ts"));
  const { MessageReceipts } = await import(join(scratch, "receipts/index.ts"));
  const pending = { id: "durable-batch", prose: "", text: '<chat-selection>\n  text: "quote"\n  feedback: ""\n</chat-selection>', attachments: [{ kind: "file", attachment: { type: "uploaded_file", id: "file", path: "/fixture" } }], draftIds: ["draft"], messageId: null, wire: null, state: "prepared" as const };
  const row = JSON.parse(JSON.stringify(queuedBatch(pending, "host", "agent")));
  const store = new Map([["agent", [row]]]); let sent: any, optimistic: any, count = 0;
  const receiptHome = join(scratch, "home"); await mkdir(receiptHome); await writeFile(join(receiptHome, "server-id"), "host\n");
  const receipts = new MessageReceipts(join(receiptHome, "agent-requests"));
  const result = await native.sendQueuedComposerMessageNow({ agentId: "agent", messageId: row.id, queue: { read: (id: string) => store.get(id), write: (update: any) => { const next = update(store); store.set("agent", next.get("agent")); } }, submitMessage: ({ text, attachments }: any) => native.dispatchComposerAgentMessage({ agentId: "agent", text, attachments, encodeImages: async () => [], activeTurnBehavior: "steer", submission: { begin(_agent: string, message: any) { optimistic = message; }, accept() {}, reject() {} }, client: { async sendAgentMessage(agent: string, text: string, options: any) {
    const carrier = stripBatchCarrier(options); assert.equal(carrier.id, pending.id); assert.equal((carrier.options.attachments as any[]).length, 1);
    const request = { prompt: native.buildAgentPrompt(text, carrier.options.images, carrier.options.attachments), activeTurnBehavior: carrier.options.activeTurnBehavior };
    await receipts.send({ agentId: agent, messageId: options.messageId, request, send: async () => { count++; } });
    sent = { ...pending, messageId: options.messageId, wire: JSON.stringify({ text, options: carrier.options }), state: "dispatching" };
  } } }) });
  assert.equal(optimistic.attachments.length, 1);
  assert.equal(result.status, "submitted"); assert.equal(count, 1); assert.deepEqual(store.get("agent"), []);
  assert.equal(await hasCompletedReceipt(receiptHome, "host", "agent", sent), true);
  assert.equal(JSON.stringify(sent).includes("tether-annotation-batch"), false);
  console.log("Pinned Paseo 0.11.2 functions passed: native queued send, attachment conversion, identity removal, prompt fingerprint, durable receipt verification.");
} finally { await rm(scratch, { recursive: true, force: true }); }
