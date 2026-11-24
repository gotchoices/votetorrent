// One call that opens everything a device home needs for a vault-backed role daemon: the per-device
// keys, the FileKeyVault and the sealed KeyVaultStorage identity store. Replaces the rig's
// `new InMemoryTestKeyVault()` + `mapKeyVaultStorage()` pair one for one, so a daemon can stop and
// restart between accept, DKG and release.

import { join } from 'node:path'
import type { ApprovalContext } from '../approval/token.js'
import { DeviceKeys, fileVaultErrorFrom, openDeviceKeys } from './device-keys.js'
import { FileKvStorage, openSealedFileKv } from './file-kv.js'
import { FileKeyVault } from './file-vault.js'
import { ensurePrivateDir } from './private-file.js'

/** Sub-directory of a device home that holds the key files, the records and the sealed identity store. */
export const DEFAULT_VAULT_DIR = 'vault'
/** The sealed KeyVaultStorage file inside DEFAULT_VAULT_DIR. */
export const DEFAULT_KEY_VAULT_STORAGE_FILE = 'keyvault-storage.sealed.json'
/** AAD label of the sealed identity store. */
export const KEY_VAULT_STORAGE_LABEL = 'key-vault-storage'

export interface OpenDeviceVaultOptions {
  readonly home: string
  readonly approval?: ApprovalContext
  readonly onAuthPrompt?: (alias: string) => void
}

export interface DeviceVault {
  readonly home: string
  readonly keys: DeviceKeys
  readonly vault: FileKeyVault
  readonly storage: FileKvStorage
  /** Closes the storage and disposes the keys. Idempotent. */
  close(): void
}

export function openDeviceVault(opts: OpenDeviceVaultOptions): DeviceVault {
  const { home, approval, onAuthPrompt } = opts
  try {
    ensurePrivateDir(home)
  } catch (e) {
    throw fileVaultErrorFrom(e, home, 'home')
  }
  const vaultDir = join(home, DEFAULT_VAULT_DIR)
  const keys = openDeviceKeys(vaultDir)
  let storage: FileKvStorage
  try {
    const vault = new FileKeyVault({ keys, approval, onAuthPrompt })
    storage = openSealedFileKv({ path: join(vaultDir, DEFAULT_KEY_VAULT_STORAGE_FILE), keys, label: KEY_VAULT_STORAGE_LABEL })
    let closed = false
    return {
      home,
      keys,
      vault,
      storage,
      close() {
        if (closed) return
        closed = true
        storage.close()
        keys.dispose()
      }
    }
  } catch (e) {
    keys.dispose()
    throw e
  }
}
