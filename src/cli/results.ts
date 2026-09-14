import { diagnosticValue } from "../shared/diagnostics";

/** Project application results, leaving browser snapshots and explicit diagnostics intact. */
export function commandResult(command: string, payload: unknown): unknown {
  if (!["recents.add", "folio.add", "folio.archive", "folio.restore", "folio.pin", "folio.settings", "folio.import"].includes(command) || !payload || typeof payload !== "object") return payload;
  const { entries, hostSynchronized, hostSyncStatus, hostSequence, hostIssue, ...result } = payload as Record<string, unknown>;
  if ((command === "recents.add" || command === "folio.add") && Array.isArray(result.added)) {
    result.added = (result.added as Array<{ path: string }>).map(({ path }) => ({ path }));
  }
  if (hostSyncStatus === "failed") result.warnings = [{
    code: "host_sync_failed",
    message: "The document operation completed, but recent-document shortcuts could not be updated.",
    details: diagnosticValue(hostIssue),
  }];
  if (command === "folio.import" && result.registration) result.registration = commandResult("folio.add", result.registration);
  return result;
}
