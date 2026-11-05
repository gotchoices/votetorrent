import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Database } from '@quereus/quereus'
import {
  encodeRegistrationCodeBits,
  REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
  REGISTRATION_CODE_BINDING_DOMAIN,
  REGISTRATION_CODE_DOMAIN,
  ReassociationError
} from '@votetorrent/vote-core'
import type { Signature } from '@votetorrent/vote-core'
import { bytesToBase64url } from '../../utils.js'

/**
 * deriveRegistrationCodeWith(registrantId, sign) — 62-18 (D-01, D-45).
 *
 * The registering device's ONLY route to a re-join code: the registrant's identity key never
 * leaves the device (D-01), so the code is derived here as a pure function of a SIGNING CALLBACK
 * over a fixed, domain-separated digest — never from a raw key. The authority can never compute
 * this value itself; it only ever compares a PRESENTED code against the sealed copy carried
 * inside the registering device's own `RegistrationRequestStaging` row (D-45) — never by deriving
 * one independently.
 *
 * Re-showing the code (62-28: "show my code again") depends on this being REPRODUCIBLE from the
 * same key — so the digest is signed TWICE and the two signatures are required to be byte
 * identical. A hedged/nondeterministic signer (noble's `extraEntropy: true`, or any hardware
 * signer that randomizes `k`) would silently make the code unreproducible on a second call, so
 * that case is rejected outright rather than shipped as a code nobody could ever re-derive.
 *
 * Uses `@noble/hashes` (`sha2.js`, `utils.js`) only — no Node Buffer global (Hermes gate).
 */
export async function deriveRegistrationCodeWith (
  registrantId: string,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  if (typeof registrantId !== 'string' || registrantId.length === 0 || registrantId === REASSOCIATION_UNRESOLVED_REGISTRANT_ID) {
    throw new ReassociationError('invalid-argument', 'deriveRegistrationCodeWith: registrantId must be a non-empty, non-sentinel string')
  }

  const digest = sha256(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}\n${registrantId}`))

  const first = await sign(digest)
  const second = await sign(digest)
  if (first.signature !== second.signature) {
    throw new ReassociationError(
      'non-deterministic-signer',
      'deriveRegistrationCodeWith: signer produced two different signatures over the same digest — the registration code must be reproducible from the identity key alone'
    )
  }

  const material = sha256(concatBytes(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}/code`), hexToBytes(first.signature)))
  return encodeRegistrationCodeBits(material)
}

/**
 * registrationCodeBindingDigest(requestId, code) — 62-35 (V-3, D-45).
 *
 * The digest the REQUESTER signs to bind its registration code to its own request id:
 * `sha256(REGISTRATION_CODE_BINDING_DOMAIN \n requestId \n code)`. The signature rides inside the
 * sealed staging plaintext next to the code; the officer side accepts a code only when it verifies
 * against the approved request's `RequesterKey`. Without it any strand writer could stage a row
 * for a victim's cleartext RequestId carrying a code of its own.
 *
 * Rejects empty inputs; the message never names a code value.
 */
export function registrationCodeBindingDigest (requestId: string, code: string): Uint8Array {
  if (typeof requestId !== 'string' || requestId.length === 0 || typeof code !== 'string' || code.length === 0) {
    throw new ReassociationError('invalid-argument', 'registrationCodeBindingDigest: requestId and code must be non-empty strings')
  }
  return sha256(utf8ToBytes(`${REGISTRATION_CODE_BINDING_DOMAIN}\n${requestId}\n${code}`))
}

/**
 * Verifies a requester's binding signature over (requestId, code) against `requesterKey` with the
 * schema's own `SignatureValid` / `SignatureValidP256` UDFs (the same verifiers the staging
 * tables' CHECKs use, over the base64url digest). NEVER throws: any malformed input or verifier
 * error is `false`.
 */
export async function verifyRegistrationCodeBinding (
  db: Database,
  args: { readonly requestId: string; readonly code: string; readonly signature: string; readonly requesterKey: string }
): Promise<boolean> {
  try {
    const { requestId, code, signature, requesterKey } = args
    if (
      typeof requestId !== 'string' || requestId.length === 0 ||
      typeof code !== 'string' || code.length === 0 ||
      typeof signature !== 'string' || signature.length === 0 ||
      typeof requesterKey !== 'string' || requesterKey.length === 0
    ) return false
    const bindingDigest = bytesToBase64url(registrationCodeBindingDigest(requestId, code))
    const row = await db
      .prepare('select (SignatureValid(:bindingDigest, :bindingSignature, :requesterKey) or SignatureValidP256(:bindingDigest, :bindingSignature, :requesterKey)) as ok')
      .get({ bindingDigest, bindingSignature: signature, requesterKey })
    return row !== undefined && (row.ok === true || row.ok === 1)
  } catch {
    return false
  }
}
