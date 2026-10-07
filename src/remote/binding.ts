import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { TetherConfig } from "../server/config";

export type RemoteBinding = { connection: string; receiver?: string };
/** Application configuration, not an agent instruction or a second library. */
export async function readRemoteBinding(config: TetherConfig): Promise<RemoteBinding | null> {
  const file = await open(join(config.configDir, "remote-binding.json"), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!file) return null;
  try {
    const info = await file.stat(); if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 8192) throw new Error("Remote binding must be an owner-only regular file.");
    const value = JSON.parse(await file.readFile("utf8"));
    if (typeof value.connection !== "string" || !value.connection.startsWith("/") || value.receiver !== undefined && typeof value.receiver !== "string") throw new Error("Invalid remote binding.");
    return value;
  } finally { await file.close(); }
}
export async function writeRemoteBinding(config: TetherConfig, binding: RemoteBinding) {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  const path = join(config.configDir, "remote-binding.json"), temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(binding) + "\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
