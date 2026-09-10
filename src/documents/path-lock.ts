import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { join } from "node:path";

let native: ReturnType<typeof dlopen<{ flock: { args: [FFIType.i32, FFIType.i32]; returns: FFIType.i32 } }>> | undefined;
function flock(fd: number, operation: number): number {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Tether writer coordination requires macOS or Linux.");
  native ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return native.symbols.flock(fd, operation);
}

/** Kernel advisory locks release on process exit, including crashes. Never unlink
 * the lock inode: waiting/open descriptors must continue to name the same lock. */
export async function acquireFileLock(file: string): Promise<{ release: () => Promise<void> }> {
  const handle = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe Tether writer lock.");
    if (flock(handle.fd, 2 | 4) !== 0) throw Object.assign(new Error("Another Tether writer is using this path. Retry after it finishes."), { code: "writer_busy", status: 409 });
    return { release: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

export async function withPathLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const root = join("/tmp", `tether-writers-${process.getuid?.() ?? "local"}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe Tether writer-lock directory.");
  const lock = await acquireFileLock(join(root, createHash("sha256").update(path).digest("hex")));
  try { return await action(); }
  finally { await lock.release(); }
}
