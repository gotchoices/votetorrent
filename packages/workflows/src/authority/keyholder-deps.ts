/**
 * keyholder-deps.ts: the shared required-dependency check of the three keyholder drivers (phase 67
 * plan 14). A driver's platform seams (`vault`, `storage`) are injected parameters with NO default:
 * the app bindings supply the app's secret vault and key-value store, the CLI supplies its file-backed
 * vault and store. A call without both is a caller bug, refused with a TypeError (fixed message, no
 * identifier, alias or value) as the FIRST statement of each driver, before any engine read, vault
 * call or key generation. Reached only through relative imports; not exported from the barrel.
 */

import type { IKeyVault } from '@votetorrent/vote-engine/rn'
import type { KeyVaultStorage } from '../platform/storage.js'

export type KeyholderDriverName = 'keyholder-accept' | 'keyholder-dkg-driver' | 'key-release-ceremony'

export interface KeyholderDriverDeps {
  vault: IKeyVault
  storage: KeyVaultStorage
}

const VAULT_MEMBERS = ['getSecret', 'putSecret', 'hasSecret', 'deleteSecret'] as const
const STORAGE_MEMBERS = ['getItem', 'setItem', 'removeItem'] as const

function hasFunctions(value: unknown, members: readonly string[]): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return members.every((member) => typeof record[member] === 'function')
}

/** Throws a TypeError with the fixed required-dependencies message unless both seams are present and well-formed. */
export function requireKeyholderDeps(deps: unknown, who: KeyholderDriverName): void {
  const d = deps as Partial<KeyholderDriverDeps> | null | undefined
  if (d === null || typeof d !== 'object' || !hasFunctions(d.vault, VAULT_MEMBERS) || !hasFunctions(d.storage, STORAGE_MEMBERS)) {
    throw new TypeError(`${who}: vault and storage are required`)
  }
}
