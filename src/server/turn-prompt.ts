import type { Identity } from "../shared/agent-identity";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Clipboard text contains no credential and never starts a turn itself. */
export function turnAssignmentPrompt(input: {
  path: string; profile: string; executable?: string; sharedDocumentId?: string; role?: Identity; recipientId?: string; label?: string;
}): string {
  const cli = input.sharedDocumentId ? "tether" : `TETHER_PROFILE=${quote(input.profile)} ${input.executable ? quote(input.executable) : "tether"}`;
  const path = quote(input.sharedDocumentId ? `id:${input.sharedDocumentId}` : input.path);
  if (input.role) return [
    `Take over this Tether role by running the command below from your own session, then follow its returned instructions.`,
    `${cli} turn takeover ${path} --role-id ${quote(input.role.id)} --expected-recipient ${quote(input.recipientId!)}`,
  ].join("\n\n");
  return [
    `Assign yourself to the empty Go slot on the Tether document ${JSON.stringify(input.path)}.`,
    `Use your own Paseo session and preserve the reader's configured profile and connection. Inspect ${cli} turn status ${path}, choose a descriptive role name and one of availableIcons, then run:`,
    `${cli} turn register ${path} --actor 'YOUR ROLE NAME' --icon 'CHOSEN AVAILABLE ICON' --if-empty`,
    `Tether assigns the next color in its rotation. If availableIcons is empty, omit --icon to use the existing reuse policy. If your session already has an identity, keep its name and icon and omit --icon.`,
    `If another agent has filled the slot, stop; do not replace it. If your host cannot receive Go events, report that limitation rather than claiming registration succeeded.`,
    `Read the document and its pending review threads, adopt its requested role, and handle outstanding work. Keep the returned identity and name. A <tether-turn> event requests your next turn on its document. Do not send a turn yourself.`,
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
