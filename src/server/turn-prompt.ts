import type { Identity } from "../shared/agent-identity";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Clipboard text contains no credential and never starts a turn itself. */
export function turnAssignmentPrompt(input: {
  path: string; profile: string; executable?: string; sharedDocumentId?: string; role?: Identity; recipientId?: string; label?: string;
}): string {
  const cli = input.sharedDocumentId ? "tether" : `TETHER_PROFILE=${quote(input.profile)} ${input.executable ? quote(input.executable) : "tether"}`;
  const path = quote(input.sharedDocumentId ? `id:${input.sharedDocumentId}` : input.path);
  if (input.role) return [
    `Take over the Tether role ${JSON.stringify(input.role.name)} on ${JSON.stringify(input.path)}.`,
    `This transfers the identity everywhere it is registered, including its role labels and future mention target. Keep identity ${JSON.stringify(input.role.id)}, name ${JSON.stringify(input.role.name)}, icon ${JSON.stringify(input.role.icon)}, and color slot ${input.role.colorSlot}.`,
    ...(input.label ? [`Document role: ${JSON.stringify(input.label)}.`] : []),
    `Run this command from your own Paseo session, preserving the reader's configured profile and connection:`,
    `${cli} turn takeover ${path} --role-id ${quote(input.role.id)} --expected-recipient ${quote(input.recipientId!)}`,
    `This redirects future Go presses and retires outstanding invitations without replaying them. It does not stop work the previous session has already begun.`,
    `Use the returned role name for --actor. Let the CLI identify your actual host session; do not impersonate the old session with --agent-id. If the command reports a changed role, stop and report that result.`,
    `Read the document and its pending review threads, adopt the role described there, and handle outstanding work. Tether preserves the role's attribution and review cursors; it does not transfer the previous agent's private memory. A <tether-turn> event requests your next turn on its document. Do not send a turn yourself.`,
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
