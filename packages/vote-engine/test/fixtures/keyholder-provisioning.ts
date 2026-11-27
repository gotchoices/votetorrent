// keyholder-provisioning.ts — 62-02 Task 3 test fixture.
//
// Generates a real `KeyholderAcceptProvisioning` (packages/vote-core/src/invite/models.ts) for use
// in `respondToInvite`'s keyholder-accept tests: a fresh signing keypair (never the officer's),
// a fresh 66-char DKG receiving public key, and a `sign` callback over the digest bytes in the
// same form `makeTestSignCallback` uses. The private halves stay local to this fixture — only
// `sign` and the public `signingKey`/`dkgPublicKey` cross into the engine, mirroring the real
// contract's "private keys never enter vote-engine" rule.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { UserKeyType } from '@votetorrent/vote-core'
import type { KeyholderAcceptProvisioning, Signature } from '@votetorrent/vote-core'
import { randomTestKeyPair } from './keys.js'

export interface TestKeyholderProvisioning extends KeyholderAcceptProvisioning {
  privateKeyHex: string
}

export function makeKeyholderProvisioning (options?: { curve?: 'secp256k1' | 'p256' }): TestKeyholderProvisioning {
  const curve = options?.curve ?? 'secp256k1'

  let privateKeyHex: string
  let signingPublicHex: string
  if (curve === 'p256') {
    const priv = p256.utils.randomSecretKey()
    privateKeyHex = bytesToHex(priv)
    signingPublicHex = bytesToHex(p256.getPublicKey(priv))
  } else {
    const pair = randomTestKeyPair()
    privateKeyHex = pair.privateHex
    signingPublicHex = pair.publicHex
  }

  // Fresh receiving (DKG) public key — always secp256k1 per 62-05's locked shape, independent of
  // the signing key's own curve.
  const { publicHex: dkgPublicKey } = randomTestKeyPair()

  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const privBytes = hexToBytes(privateKeyHex)
    const signature = curve === 'p256'
      ? bytesToHex(p256.sign(digest, privBytes))
      : bytesToHex(secp256k1.sign(digest, privBytes))
    return { signature, signerKey: signingPublicHex, signerUserId: '' }
  }

  return {
    signingKey: {
      key: signingPublicHex,
      type: curve === 'p256' ? UserKeyType.p256 : UserKeyType.mobile,
      expiration: Date.now() + 10 * 365 * 86_400_000,
    },
    dkgPublicKey,
    sign,
    privateKeyHex,
  }
}
