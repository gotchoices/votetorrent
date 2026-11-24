// Runs the schema's own SQL verifiers, SignatureValid (secp256k1) and SignatureValidP256 (P-256), on a
// fresh quereus Database with VoteTorrent's functions registered: the same code path a strand's CHECK
// takes. A signature the signer produces must pass here, not only noble's verify.

import { Database } from '@quereus/quereus'
import { registerVoteTorrentFunctions } from '@votetorrent/vote-engine/rn'
import type { TokenSignerCurve } from '../../src/approval/signer.js'

const DIGEST_BYTES = 32

/** The 43-char unpadded base64url text SQL passes for a 32-byte digest (the Digest() output form). */
export function digestText(digest: Uint8Array): string {
  if (!(digest instanceof Uint8Array) || digest.length !== DIGEST_BYTES) {
    throw new Error(`digestText: a digest is exactly ${DIGEST_BYTES} bytes`)
  }
  return Buffer.from(digest).toString('base64url')
}

/** True when the SQL verifier for `curve` accepts the hex signature over `digest` under the hex compressed key. */
export async function schemaSignatureValid(
  curve: TokenSignerCurve,
  digest: Uint8Array,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  const fn = curve === 'p256' ? 'SignatureValidP256' : 'SignatureValid'
  const db = new Database()
  try {
    await registerVoteTorrentFunctions(db)
    const row = (await db
      .prepare(`select ${fn}(:d, :s, :k) as ok`)
      .get({ d: digestText(digest), s: signatureHex, k: publicKeyHex })) as { ok?: unknown } | undefined
    return row?.ok === true || row?.ok === 1
  } finally {
    await db.close()
  }
}
