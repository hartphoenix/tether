import { join } from "node:path";

export async function sourceRevision(): Promise<string> {
  try {
    const git = async (args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "ignore" });
      const text = await new Response(child.stdout).text(); if (await child.exited) throw new Error("No source revision"); return text.trim();
    };
    const commit = await git(["rev-parse", "HEAD"]);
    return await git(["status", "--porcelain", "--untracked-files=normal"]) ? `${commit} (uncommitted build; obtain the reviewed source revision before installing)` : commit;
  } catch { return "the reviewed source revision supplied with this build"; }
}
