/**
 * key-release-ceremony.ts: keyholder share release ceremony (D-17, D-20). Never throws once its required
 * dependencies are supplied; a call without vault or storage is refused with a TypeError before any
 * engine or vault call.
 *
 * Moved from the Authority app's `src/screens/keyholder/key-release-ceremony.ts` (phase 67 plan
 * 14); the app path is now a thin binding that supplies the app's key-value store. `vault` and
 * `storage` are REQUIRED parameters here (no default store).
 *
 * Four points:
 *  1. D-20 entry path: the ceremony is only reachable from a release-key task in the Tasks inbox,
 *     and those tasks exist only once the election timeline has entered `releasingKeys` (the
 *     release engine's pull-and-seed, run by `getKeysToRelease(true)`). Nothing here seeds,
 *     schedules or polls.
 *  2. D-17 effect: a successful run leaves one public, signed `KeyholderShareRelease` row under the
 *     KEYHOLDER's own identity key. The signer ALWAYS accompanies the completion call: a call with
 *     no signer is refused by the engine (`signer-required`), and this ceremony never uses the
 *     officer's device key.
 *  3. Prompt budget: a first release performs two auth-required vault reads (the share, then the
 *     signing key) inside ONE keyholder session (`withKeyholderSession`): one prompt on the seat
 *     vault (the app's `keyholder-seat-vault.ts`), two on a plain per-alias vault. A repeat on an
 *     already-released task performs zero; a device that does not hold the task's keyholder identity
 *     performs zero and writes nothing, because the identity lookup runs before the engine or the
 *     vault is touched.
 *  4. This module never reconstructs a key (D-16): it only publishes one share.
 *
 * The outcome carries a machine code, never an error message, so nothing here can leak an identifier
 * into a screen.
 */

import type { IKeysTasksEngine, ReleaseKeyTask } from '@votetorrent/vote-core'
import type { IKeyVault } from '@votetorrent/vote-engine/rn'
import type { KeyVaultStorage } from '../platform/storage.js'
import { createKeyholderSigner, getKeyholderIdentity } from './keyholder-identity.js'
import { withKeyholderSession } from './keyholder-session.js'
import { requireKeyholderDeps } from './keyholder-deps.js'

export interface KeyReleaseCeremonyDeps {
  getEngine: <T>(engineName: string) => Promise<T>
  vault: IKeyVault
  /** REQUIRED: the public identity store. The shared code has no default (the app binding supplies its own). */
  storage: KeyVaultStorage
}

export type KeyReleaseCeremonyOutcome = { kind: 'released' } | { kind: 'failed'; code: string; authDenied: boolean }

function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}

function failed(code: string): KeyReleaseCeremonyOutcome {
  return { kind: 'failed', code, authDenied: code === 'auth-denied' }
}

export async function releaseKeyholderShare(deps: KeyReleaseCeremonyDeps, task: ReleaseKeyTask): Promise<KeyReleaseCeremonyOutcome> {
  requireKeyholderDeps(deps, 'key-release-ceremony')
  try {
    const identity = await getKeyholderIdentity(task.userId, deps.storage)
    if (identity === undefined) {
      return failed('identity-not-found')
    }
    const engine = await deps.getEngine<IKeysTasksEngine>('keysTasksEngine')
    const signer = createKeyholderSigner({ vault: deps.vault }, identity)
    await withKeyholderSession(deps.vault, identity.userId, () => engine.completeKeyRelease(task, signer))
    return { kind: 'released' }
  } catch (err) {
    return failed(codeOf(err))
  }
}

/** Catalog key for a failed outcome: biometric denial gets the generic verify copy, everything else the release copy. */
export function keyReleaseErrorCopyKey(outcome: Extract<KeyReleaseCeremonyOutcome, { kind: 'failed' }>): 'deviceSigningErrorGeneric' | 'keyholderReleaseError' {
  return outcome.authDenied ? 'deviceSigningErrorGeneric' : 'keyholderReleaseError'
}
