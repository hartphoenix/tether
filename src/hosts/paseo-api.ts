/**
 * Runs under Paseo's bundled Node runtime, which can load its ASAR SDK. Keep the
 * private-runtime dependency here: no credentials or application code are copied.
 * The CLI cannot pass a message ID or non-interrupting send behavior.
 */
export const PASEO_API_SEND = String.raw`
const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
(async () => {
  const [modulePath, home, agentId, messageId, promptFile] = process.argv.slice(2);
  const { connectToDaemon } = await import(pathToFileURL(modulePath).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home } });
  try {
    const text = await readFile(promptFile, 'utf8');
    // A final host-side check narrows the race; steer makes the send safe even
    // if another client starts a turn between this check and server acceptance.
    const result = await client.fetchAgent(agentId);
    const agent = result?.agent;
    if (!agent || agent.id !== agentId || agent.archivedAt) throw new Error('Agent missing or archived.');
    if (agent.status !== 'idle' || agent.pendingPermissions?.length) {
      process.stdout.write(JSON.stringify({ busy: true })); return;
    }
    await client.sendAgentMessage(agentId, text, { messageId, activeTurnBehavior: 'steer' });
    process.stdout.write(JSON.stringify({ accepted: true }));
  } finally { await client.close(); }
})().catch(() => { process.stderr.write('Paseo API send failed; acceptance is uncertain.'); process.exitCode = 1; });
`;
