import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

// Run the same script with a baseline checkout and the working tree. Measurements
// are serialized CLI envelope bytes, never provider token/billing attribution.
const root = resolve(process.argv[2] ?? ".");
const { runCli } = await import(join(root, "src/cli/main.ts"));
const { startDaemon } = await import(join(root, "src/server/server.ts"));
const { resolveConfig } = await import(join(root, "src/server/config.ts"));
const dir = await mkdtemp("/tmp/tether-cost-replay-");
const config = resolveConfig({ profile: "replay", configDir: join(dir, "config"), runtimeDir: join(dir, "runtime") });
let daemon = await startDaemon({ config, web: () => new Response("fixture") });
const path = join(dir, "doc.md"), bodyFile = join(dir, "reply.txt");
const rows: { scenario: string; requests: string[][]; exchanges: number; inputBytes: number; responseBytes: number; completed: boolean }[] = [];
let row!: typeof rows[number];
const begin = (scenario: string) => { row = { scenario, requests: [], exchanges: 0, inputBytes: 0, responseBytes: 0, completed: false }; rows.push(row); };
async function call(args: string[], expected = true) {
  const result = await runCli(args, { config, open: async () => {} });
  row.requests.push(args.map((a, index) => args[index - 1] === "--cursor" ? "$CURSOR" : a.replaceAll(dir, "$FIXTURE")));
  row.exchanges++; row.inputBytes += Buffer.byteLength(JSON.stringify(args));
  row.responseBytes += Buffer.byteLength(JSON.stringify(result.response) + "\n");
  if (result.response.ok !== expected) throw new Error(`Unexpected outcome: ${JSON.stringify(result.response)}`);
  return result.response;
}
try {
  await writeFile(path, "# Fixture\n\nReview this paragraph.\n"); await writeFile(bodyFile, "Answered.");
  const seeded = await runCli(["comment", path, "--actor", "human", "--quote", "Review this paragraph.", "--body-file", bodyFile, "--operation-id", "seed"], { config });
  if (!seeded.response.ok) throw new Error("Fixture failed");
  const seedPending = await runCli(["pending", path, "--actor", "assistant"], { config });
  const threadId = seedPending.response.data.events[0].id;
  begin("registration"); await call(["recents", "add", path]); row.completed = true;
  begin("review");
  const pending = await call(["pending", path, "--actor", "assistant"]);
  await call(["thread", path, threadId]);
  await call(["reply", path, threadId, "--actor", "assistant", "--body-file", bodyFile, "--operation-id", "reply"]);
  await call(["acknowledge", path, "--actor", "assistant", "--cursor", pending.data.cursor, "--operation-id", "ack"]);
  const after = await call(["pending", path, "--actor", "assistant"]);
  if (after.data.events.length) throw new Error("Acknowledged events repeated"); row.completed = true;
  begin("invalid-context-correction");
  const invalid = await call(["document", "context", path, "--start-line", "2"], false);
  if (!invalid.error.message.includes("<thread-id>")) await call(["document", "context", "--help"]);
  await call(["document", "context", path, threadId]); row.completed = true;
  begin("unavailable-diff");
  const diff = await call(["document", "diff", path, "--from-revision", `sha256:${"0".repeat(64)}`, "--max-bytes", "2048"]);
  if (JSON.stringify(diff).includes('"content"')) throw new Error("Unexpected full document fallback"); row.completed = true;
  begin("daemon-loss"); await daemon.stop(); daemon = await startDaemon({ config, web: () => new Response("fixture") });
  await call(["thread", path, threadId]); row.completed = true;
  begin("large-document-cold-start");
  await writeFile(path, "# Fixture\n\nReview this paragraph.\n\n" + "## Section\n\n" + "Long document content.\n".repeat(10_000));
  const outline = await call(["document", "outline", path, "--max-bytes", "2048"]);
  if (JSON.stringify(outline).includes('"content"')) throw new Error("Unexpected full document fallback"); row.completed = true;
  console.log(JSON.stringify({ measurement: "synthetic CLI envelopes; one sequential call per exchange; setup excluded; equal-length random fixture paths", scenarios: rows }, null, 2));
} finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
