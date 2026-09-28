import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PaseoLookup } from "./hub";

/** Paseo lookups through a handler's API. */
export function paseoLookup(paseo: PluginHandlerContext["paseo"]): PaseoLookup {
  return {
    async terminalWorkspace(terminalId) {
      return (await paseo.terminals.ref(terminalId).refresh())?.workspaceId ?? null;
    },
  };
}
