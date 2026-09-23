import { createPrivateKey, createPublicKey } from 'node:crypto';
import { onePassword, type PublisherVault } from './vault';

export const keychainVaultName = 'macos-keychain';
const item = 'com.hartphoenix.tether.publisher';
export function publisherDocument(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const value = env.TETHER_PUBLISHER_DOCUMENT;
  if (!value || Buffer.byteLength(value) > 32768) throw new Error('Launch this session with the Tether publisher Keychain helper.');
  try {
    const parsed = JSON.parse(value);
    if (parsed.format !== 1 || parsed.purpose !== 'tether-publisher' || createPrivateKey(parsed.privateKey).asymmetricKeyType !== 'ed25519') throw new Error();
    return Buffer.from(value);
  } catch { throw new Error('Invalid publisher environment; no private contents were logged.'); }
}
export function publisherVault(env: NodeJS.ProcessEnv = process.env): PublisherVault {
  const publicIdentity = (bytes: Uint8Array) => createPublicKey(createPrivateKey(JSON.parse(Buffer.from(bytes).toString()).privateKey)).export({type:'spki',format:'der'});
  return {
    async create(vault, title, contents) {
      if (vault !== keychainVaultName) return onePassword().create(vault, title, contents);
      const existing = publisherDocument(env);
      try {
        if (!publicIdentity(existing).equals(publicIdentity(contents))) throw new Error('Publisher key does not match the existing Keychain item.');
        return item;
      } finally { existing.fill(0); }
    },
    async read(vault, id) {
      if (vault !== keychainVaultName) return onePassword().read(vault, id);
      if (id !== item) throw new Error('Unexpected publisher item.');
      return publisherDocument(env);
    },
  };
}
