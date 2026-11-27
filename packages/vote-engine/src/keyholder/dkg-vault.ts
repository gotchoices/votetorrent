// src/keyholder/dkg-vault.ts — the in-progress DKG round-secret vault alias
// (62-17: D-16, D-19). This resolves the open item 62-05 left at
// `src/crypto/dkg.ts`'s "Consumer notes": `serializeDkgSecret` output is
// SECRET (the dealer's own polynomial coefficients) and goes ONLY to
// `IKeyVault`, never to a row, a log or an error message.
//
// Why `requireUserAuth: true` (D-16): the coefficients let their holder
// compute every share this dealer issued to every recipient — they are
// strictly MORE sensitive than any single released share, so they get the
// same biometric-gated policy as `KEYHOLDER_SHARE_POLICY`.
//
// Why TWO step-suffixed aliases exist, not one (D-19 round driver, Task 2's
// crash-recovery requirement): noble's split-round `DKG_Secret.step` moves
// from 1 (post round1, pre round2) to 2 (post round2, pre round3) as a
// SIDE EFFECT of `dkgRound2`. The step-1 record holds the secret BEFORE
// round 2 is run, alongside the unrevealed R1 package (noble's `DKG_Secret`
// does not itself carry the Schnorr proof of knowledge, and the package must
// stay hidden until every roster member's R0 commit is visible — publishing
// it early would let a rushing peer tailor its own R1 after seeing others').
// The round driver writes the step-2 record BEFORE it deletes the step-1
// record, so a crash between those two operations never loses the only
// surviving copy of the secret: at every instant at least one of the two
// aliases holds it. `putSecret`'s `'alias-exists'` refusal (62-04) is what
// makes this ordering safe — a second `putSecret` call after a crash-restart
// cannot silently clobber whichever record survived.
//
// This record never reaches a `KeyholderDkgMessage` row, a log line or a
// thrown error message — `decodeDkgRoundVaultRecord`'s own error text below
// is checked (`dkg.spec.ts` scenario L) to carry no 64-hex run.

import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { DkgRound1Wire } from '../crypto/dkg.js'
import { DKG_MAX_ATTEMPTS } from '@votetorrent/vote-core'
import { assertKeyVaultAlias, type KeyVaultPolicy } from '../crypto/vault.js'

export const KEYHOLDER_DKG_ROUND_SECRET_POLICY: KeyVaultPolicy = { requireUserAuth: true }

/**
 * `KeyholderDkgError` is declared HERE (not in `keyholder-dkg-engine.ts`,
 * where `<interfaces>` nominally places it) because this module needs it
 * before the engine exists — Task 1 builds the pure/vault modules first,
 * Task 2 adds the engine. `keyholder-dkg-engine.ts` re-exports this class so
 * every caller's declared import path (`from './keyholder-dkg-engine.js'`)
 * still resolves. Recorded in the SUMMARY per the plan's instruction.
 */
export type KeyholderDkgErrorCode =
  | 'not-a-keyholder' | 'signer-key-mismatch' | 'signature-mismatch'
  | 'receiving-key-missing' | 'round-secret-missing' | 'round-secret-corrupt' | 'no-current-revision'

export class KeyholderDkgError extends Error {
  readonly code: KeyholderDkgErrorCode

  constructor (code: KeyholderDkgErrorCode, message: string) {
    super(message)
    this.name = 'KeyholderDkgError'
    this.code = code
  }
}

export function keyholderDkgRoundSecretAlias (electionId: string, revision: number, attempt: number, step: 1 | 2, userId: string): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new KeyholderDkgError('round-secret-corrupt', 'keyholderDkgRoundSecretAlias: revision must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > DKG_MAX_ATTEMPTS) {
    throw new KeyholderDkgError('round-secret-corrupt', 'keyholderDkgRoundSecretAlias: attempt must be 1..DKG_MAX_ATTEMPTS')
  }
  if (step !== 1 && step !== 2) {
    throw new KeyholderDkgError('round-secret-corrupt', 'keyholderDkgRoundSecretAlias: step must be 1 or 2')
  }
  const alias = `vt.keyholder-dkg-round.${electionId}.${revision}.${attempt}.${step}.${userId}`
  // assertKeyVaultAlias throws KeyVaultError 'invalid-alias' for '/' , spaces,
  // or a result over 128 characters — exactly the gate this function's own
  // callers (and dkg-vault.spec cases) check for.
  assertKeyVaultAlias(alias)
  return alias
}

export interface DkgRoundVaultRecord {
  v: 1
  /** `serializeDkgSecret(secret)` output — the SECRET polynomial coefficients. */
  dkgSecret: string
  /** The sender's own unrevealed R1 package; posted verbatim at round 1. */
  round1: DkgRound1Wire
  /** The R0 commit hex this record's `round1` hashes to (`commitRound1` output). */
  commit: string
}

export function encodeDkgRoundVaultRecord (record: DkgRoundVaultRecord): Uint8Array {
  const payload = {
    v: 1,
    dkgSecret: record.dkgSecret,
    round1: {
      identifier: record.round1.identifier,
      commitment: record.round1.commitment,
      proofOfKnowledge: record.round1.proofOfKnowledge
    },
    commit: record.commit
  }
  return utf8ToBytes(JSON.stringify(payload))
}

/**
 * A module-private, Hermes-safe decoder — NOT a general UTF-8 decoder.
 * `bytesToUtf8` (`@noble/ciphers/utils.js`) is `TextDecoder`-backed, and
 * `sealed-payload.ts`'s header documents that `TextDecoder` is available in
 * the browser consumer but must not be assumed present on the phone. This
 * record is decoded ON-DEVICE during the round driver's own vault reads, so
 * it avoids `TextDecoder` the same way `sealed-payload.ts` avoids it for its
 * base64url helpers. A plain char-code walk is a CORRECT UTF-8 decode here
 * specifically because every byte `encodeDkgRoundVaultRecord` ever produces
 * is 7-bit ASCII: `JSON.stringify` on an object made only of hex strings,
 * digits and JSON's own structural punctuation never emits a multi-byte
 * UTF-8 sequence. A byte >= 0x80 therefore means the input is not this
 * module's own encoding, and `decodeDkgRoundVaultRecord`'s JSON.parse below
 * rejects it as corrupt (a stray `\0`-shaped character fails every field
 * check that follows).
 */
function bytesToUtf8Strict (bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!)
  }
  return out
}

export function decodeDkgRoundVaultRecord (bytes: Uint8Array): DkgRoundVaultRecord {
  let text: string
  try {
    text = bytesToUtf8Strict(bytes)
  } catch {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: not valid utf8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: not a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 1) {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: unsupported version')
  }
  if (typeof obj.dkgSecret !== 'string' || obj.dkgSecret.length === 0) {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: dkgSecret missing')
  }
  if (typeof obj.commit !== 'string' || obj.commit.length !== 64) {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: commit missing or malformed')
  }
  const round1 = obj.round1 as Record<string, unknown> | undefined
  if (
    round1 === undefined || round1 === null || typeof round1 !== 'object' ||
    typeof round1.identifier !== 'string' ||
    !Array.isArray(round1.commitment) ||
    typeof round1.proofOfKnowledge !== 'string' || round1.proofOfKnowledge.length === 0
  ) {
    throw new KeyholderDkgError('round-secret-corrupt', 'decodeDkgRoundVaultRecord: round1 missing proofOfKnowledge')
  }
  return {
    v: 1,
    dkgSecret: obj.dkgSecret,
    round1: {
      identifier: round1.identifier,
      commitment: round1.commitment as string[],
      proofOfKnowledge: round1.proofOfKnowledge
    },
    commit: obj.commit
  }
}
