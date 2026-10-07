import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sharedJson, sharedOrigin } from "../remote/shared-auth";
import { optionalFlag, requiredFlag, type ParsedCommand } from "./commands";

type Reporting = { origin: string; attemptId: string; name: string; capability: string };
export async function setupReporting(parsed: ParsedCommand) {
  const path = resolve(requiredFlag(parsed, "--state"));
  let state: Reporting;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (file) {
    try {
      const info = await file.stat(); if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 8192) throw new Error("Setup state must be an owner-only regular file.");
      state = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
  } else {
    if (parsed.spec.name !== "remote.setup") throw new Error("Create a setup contact before reporting.");
    state = { origin: sharedOrigin(requiredFlag(parsed, "--origin")), attemptId: requiredFlag(parsed, "--attempt"), name: requiredFlag(parsed, "--name"), capability: randomBytes(32).toString("base64url") };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const output = await open(path, "wx", 0o600);
    try { await output.writeFile(JSON.stringify(state) + "\n"); await output.sync(); } finally { await output.close(); }
  }
  sharedOrigin(state.origin);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state.capability) || typeof state.attemptId !== "string") throw new Error("Invalid setup state.");
  const post = async (action: string, input: object = {}) => {
    const response = await fetch(`${state.origin}/setup/${action}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${state.capability}` }, body: JSON.stringify({ attemptId: state.attemptId, ...input }) });
    const value = await sharedJson(response); if (!response.ok) throw new Error(value.error?.message ?? "Setup reporting failed; retry with the same state file.");
    return value;
  };
  if (parsed.spec.name === "remote.report") return post("report", { phase: requiredFlag(parsed, "--phase"), report: requiredFlag(parsed, "--message") });
  await post("contact", { name: state.name, capability: state.capability });
  const wait = Number(optionalFlag(parsed, "--wait") ?? 0);
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > 300) throw new Error("--wait must be 0–300 seconds.");
  const deadline = Date.now() + wait * 1000;
  let status = await post("status");
  while (!status.approved && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 1500)); status = await post("status"); }
  return { ...status, state: path, attemptId: state.attemptId };
}
