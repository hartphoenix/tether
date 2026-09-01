import { resolve } from "node:path";

export type TrashCommandRunner = (command: string[]) => Promise<void>;

async function runCommand(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode === 0) return;
  const message = child.stderr ? (await new Response(child.stderr).text()).trim() : "";
  throw new Error(message || `${command[0]} exited with status ${exitCode}`);
}

/** Move one explicitly authorized file to the macOS Trash. */
export async function moveToTrash(path: string, run: TrashCommandRunner = runCommand): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Move to Trash is currently supported only on macOS.");
  await run([
    "osascript",
    "-e", "on run argv",
    "-e", "set targetFile to POSIX file (item 1 of argv) as alias",
    "-e", "tell application \"Finder\" to delete targetFile",
    "-e", "end run",
    resolve(path),
  ]);
}
