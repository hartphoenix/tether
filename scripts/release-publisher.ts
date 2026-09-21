import { resolve } from 'node:path';
import { initializePublisher, inspectArchive, approveRelease, refreshPublisher, renewPublisher } from './releases/publisher';
import { publisherVault, publisherDocument, keychainVaultName } from './releases/environment-vault';

const help = `Usage: bun scripts/release-publisher.ts <command> [flags]
  init --directory <new-private-directory> --vault <vault> --metadata-url <url> --targets-url <url>
  inspect --archive <file>
  approve --directory <directory> --archive <file> --sha256 <reviewed-hash>
  refresh --directory <directory>
  renew --directory <directory>
No command publishes to a remote server. Upload only the generated public directory.`;
export async function run(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help') return { help };
  const schemas: Record<string, string[]> = { init: ['directory','vault','metadata-url','targets-url'], inspect: ['archive'], approve: ['directory','archive','sha256'], refresh: ['directory'], renew: ['directory'] };
  const command = args[0]!, schema = schemas[command];
  if (!schema) throw new Error('Unknown publisher command. Use --help.');
  const flags: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!.slice(2), value = args[index + 1];
    if (!args[index]!.startsWith('--') || !schema.includes(flag) || flag in flags || !value || value.startsWith('--')) throw new Error('Invalid publisher arguments. Use --help.');
    flags[flag] = value;
  }
  if (schema.some(flag => !flags[flag])) throw new Error('Missing publisher arguments. Use --help.');
  if (command === 'inspect') { const { bytes, ...summary } = await inspectArchive(resolve(flags.archive!)); return summary; }
  const directory = resolve(flags.directory!);
  if (command === 'init') return initializePublisher({ directory, vault: flags.vault!, metadataUrl: flags['metadata-url']!, targetsUrl: flags['targets-url']!, publisherDocument: flags.vault === keychainVaultName ? publisherDocument() : undefined }, publisherVault());
  if (command === 'approve') return approveRelease(directory, resolve(flags.archive!), flags.sha256!, publisherVault());
  if (command === 'renew') return renewPublisher(directory, publisherVault());
  return refreshPublisher(directory);
}
if (import.meta.main) {
  try { console.log(JSON.stringify({ ok: true, data: await run() })); }
  catch { console.error(JSON.stringify({ ok: false, error: 'Publisher operation failed. Check arguments, private-state permissions, and publisher credential access. For interrupted initialization, inspect setup.json and its named vault item before retrying.' })); process.exitCode = 1; }
}
