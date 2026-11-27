// officer-provisioning.ts - 66.1-05 test fixture (D-12).
//
// Generates a real `OfficerAcceptProvisioning` (packages/vote-core/src/invite/models.ts) for
// `respondToInvite`'s officer-accept tests: a user id, a display name and a fresh public signing key.
// Default curve is p256 (the hardware seat's key type, UserKey Type 'P'); secp256k1 gives Type 'M'.
// The private half stays in this fixture; there is no `sign` callback because the invite slot's own
// signature authorises the officer's User row.

import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { UserKeyType } from '@votetorrent/vote-core'
import type { OfficerAcceptProvisioning } from '@votetorrent/vote-core'
import { randomTestKeyPair } from './keys.js'

export interface TestOfficerProvisioning extends OfficerAcceptProvisioning {
  privateKeyHex: string
}

export function makeOfficerProvisioning (
  options?: { curve?: 'p256' | 'secp256k1'; userId?: string; name?: string }
): TestOfficerProvisioning {
  const curve = options?.curve ?? 'p256'

  let privateKeyHex: string
  let publicHex: string
  if (curve === 'p256') {
    const priv = p256.utils.randomSecretKey()
    privateKeyHex = bytesToHex(priv)
    publicHex = bytesToHex(p256.getPublicKey(priv))
  } else {
    const pair = randomTestKeyPair()
    privateKeyHex = pair.privateHex
    publicHex = pair.publicHex
  }

  return {
    userId: options?.userId ?? crypto.randomUUID(),
    name: options?.name ?? 'Test Officer',
    signingKey: {
      key: publicHex,
      type: curve === 'p256' ? UserKeyType.p256 : UserKeyType.mobile,
      expiration: Date.now() + 10 * 365 * 86_400_000,
    },
    privateKeyHex,
  }
}
