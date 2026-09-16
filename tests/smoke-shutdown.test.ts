import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitForDaemonStop } from "../scripts/wait-for-daemon-stop";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const stopped = { ok: true, data: { running: false } };
const running = { ok: true, data: { running: true } };
const closing = { ok: false, error: {
  code: "daemon_unreachable", details: { diagnostic: { code: "ConnectionRefused" } },
} };

async function probe(statuses: unknown[], timeoutMs = 2000) {
  const directory = await mkdtemp(join(tmpdir(), "tether-shutdown-test-"));
  directories.push(directory);
  const path = join(directory, "statuses.json");
  await writeFile(path, JSON.stringify(statuses));
  // Each invocation advances once; the final status persists until the deadline.
  const script = `
    const path = process.env.STATUS_PATH;
    const statuses = await Bun.file(path).json();
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    await Bun.write(path, JSON.stringify(statuses));
    console.log(JSON.stringify(status));
    process.exit(status.ok ? 0 : 1);
  `;
  return waitForDaemonStop([process.execPath, "-e", script], { env: { STATUS_PATH: path }, timeoutMs });
}

test("smoke checks tolerate shutdown refusal but require a subsequent stopped status", async () => {
  await probe([running, closing, stopped]);
});

test("persistent connection refusal does not count as stopped", async () => {
  await expect(probe([closing], 300)).rejects.toThrow("Timed out waiting for daemon shutdown");
});

test("a daemon that remains running fails the shutdown deadline", async () => {
  await expect(probe([running], 300)).rejects.toThrow("Timed out waiting for daemon shutdown");
});

test("unrelated status errors are not retried", async () => {
  await expect(probe([{ ok: false, error: { code: "control_permissions_unsafe" } }, stopped]))
    .rejects.toThrow("Daemon status failed");
});
