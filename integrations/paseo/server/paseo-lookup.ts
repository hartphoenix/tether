import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { realpath } from "node:fs/promises";
import type { PaseoLookup, WorkspacePlace } from "./hub";

async function real(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** Paseo lookups through a handler's API; Tether reports real paths, so these do too. */
export function paseoLookup(paseo: PluginHandlerContext["paseo"]): PaseoLookup {
  return {
    async terminalWorkspace(terminalId) {
      return (await paseo.terminals.ref(terminalId).refresh())?.workspaceId ?? null;
    },
    async workspaces() {
      const { entries } = await paseo.workspaces.list();
      return Promise.all(entries.map(async (workspace): Promise<WorkspacePlace> => ({
        id: workspace.id,
        directory: workspace.workspaceDirectory ? await real(workspace.workspaceDirectory) : null,
        projectRoot: await real(workspace.projectRootPath),
      })));
    },
  };
}
