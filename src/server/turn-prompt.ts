import type { Identity } from "../shared/agent-identity";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Clipboard text contains no credential and never starts a turn itself. */
export function turnAssignmentPrompt(input: {
  handoff: string; kind: "assign" | "takeover"; profile: string; executable?: string; shared?: boolean; additional?: boolean;
}): string {
  const cli = input.shared ? "tether" : `TETHER_PROFILE=${quote(input.profile)} ${input.executable ? quote(input.executable) : "tether"}`;
  const operation = input.kind;
  return [
    input.kind === "takeover" ? "Take over this Tether role, then follow the returned instructions." : input.additional ? "Join this Tether document as another agent, then follow the returned instructions." : "Assign yourself to this document’s empty Go slot, then follow the returned instructions.",
    `${cli} turn ${operation} ${quote(input.handoff)}`,
  ].join("\n\n");
}

/** Returned only after the daemon has successfully transferred the role. */
export function takeoverInstructions(role: Identity, document: string): string[] {
  return [
    `You now receive this role on every registered document. Tether preserved its identity, name, icon, color, attribution and review cursors.`,
    `Keep your own host session ID. Use ${quote(role.name)} for --actor; let the CLI identify your session rather than passing the old role ID with --agent-id. Preserve the configured profile and connection.`,
    `Read ${quote(document)} with document read, then run pending on that document with --actor ${quote(role.name)}. Follow all continuation pages and read the pending threads; reply or act on each before acknowledging its cursor.`,
    `Adopt the role described in the document and handle outstanding work. Private session memory was not transferred. The previous session may still be finishing work; takeover does not stop it.`,
    `A <tether-turn> event requests your next turn on its document. Do not send a turn yourself. Outstanding invitations were retired without replay.`,
  ];
}
