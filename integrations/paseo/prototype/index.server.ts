import { spawn } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { probeRpc } from "./contracts";

// Replaced with absolute paths by the staging script. Never reads installed plugin state.
declare const PROBE_BUN: string;
declare const PROBE_SERVICE: string;
declare const PROBE_DATABASE: string;

export default function contribute(server: PluginServerContext) {
  const children = new Set<ReturnType<typeof spawn>>();
  let stopped = false;
  server.handle(probeRpc, input => new Promise((resolve, reject) => {
    if (stopped || children.size >= 8) { reject(new Error("Prototype service busy or stopped.")); return; }
    const child = spawn(PROBE_BUN, [PROBE_SERVICE, PROBE_DATABASE], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    children.add(child);
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Prototype storage outcome uncertain. Refresh before retrying.")); }, 15_000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 16 * 1024 * 1024) { child.kill(); reject(new Error("Prototype storage response too large.")); }
    });
    child.on("error", () => reject(new Error("Prototype service could not start.")));
    child.on("close", () => {
      clearTimeout(timeout); children.delete(child);
      try {
        const result = JSON.parse(output);
        if (!result.ok) throw new Error(result.error);
        resolve(probeRpc.output.parse(result.data));
      } catch (error) { reject(error instanceof Error ? error : new Error("Prototype storage failed.")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  }));
  return () => { stopped = true; for (const child of children) child.kill(); };
}
