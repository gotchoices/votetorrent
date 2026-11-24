/**
 * storage.ts: the string key-value store seam.
 *
 * `KvStorage` is a plain string store and NOT a secret store. Callers put only public data here, or
 * data a vault has already wrapped; no plaintext secret byte, key share or private key is ever handed
 * to it. It is strings in and strings out, with no enumerate or dump member, so an implementation
 * exposes nothing beyond the keys a caller already names.
 *
 * Both apps satisfy it with the default export of their key-value store module, passed straight in,
 * and the CLI satisfies it with its file-backed kv. The three members are the whole contract: nothing
 * may be added, because every app binding passes the app store directly.
 *
 * `KeyVaultStorage` is the name the Authority key vault and the keyholder modules use for the same
 * shape (moved here from `apps/VoteTorrentAuthority/src/engines/key-vault.ts`).
 */

export interface KvStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export type KeyVaultStorage = KvStorage
