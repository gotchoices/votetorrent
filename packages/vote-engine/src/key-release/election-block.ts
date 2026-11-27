// src/key-release/election-block.ts — the D-18 block-payload contract over
// 62-04's block cipher (62-20: D-13, D-18). Pure; no DB, no `node:`, no
// `Buffer`, no `console`, no `TextDecoder`.
//
// One block encrypts its votes AND its voter records TOGETHER under the
// joint election key Y. No vote or block producer exists anywhere in this
// repository today (research Finding 6, Open Q5) — this module IS the D-18
// contract a future block builder must call (`encryptElectionBlock`), and
// `KeyReleaseEngine.decryptElectionBlocks` is its reader. A payload that
// omits voter records is refused BEFORE encryption, so a builder cannot
// leave them in clear by accident.
//
// 62-04's `block-cipher.ts` cannot itself distinguish a wrong-but-valid
// reconstructed scalar from tampering — both collapse to
// `'authentication-failed'`. The caller (`KeyReleaseEngine`) is responsible
// for asserting the reconstructed secret's public key equals the published
// `ElectionKey.JointPublicKey` BEFORE calling `openElectionBlock` — this
// module is never handed Y on the decrypt path, only the secret scalar `s`.
//
// Why no `TextDecoder`: 62-04's crypto-purity P-2 bans it inside
// `src/crypto/*` because the phone runtime (Hermes) is not guaranteed to
// have it (`sealed-payload.ts`'s header is the canonical statement). This
// module is a sibling of `src/crypto/`, not a member of it, but election
// block content (ballot text, voter names) is not guaranteed 7-bit ASCII the
// way `dkg-vault.ts`'s own hand-rolled decoder can assume — so this module
// carries its OWN real, fatal, multi-byte UTF-8 decoder (`decodeUtf8Fatal`)
// rather than reusing either shortcut.

import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type {
  ElectionBlockDecryptResult,
  ElectionBlockInput,
  ElectionBlockPayload,
  ElectionKeyRecord
} from '@votetorrent/vote-core'
import {
  BlockCipherError,
  decryptBlockContent,
  encryptBlockContent,
  type BlockCipherBinding,
  type BlockCiphertext
} from '../crypto/index.js'
import { encryptBlockContentWithRandomness, type BlockCipherRandomness } from '../crypto/block-cipher.js'

// ---------------------------------------------------------------------------
// Fatal UTF-8 decode (no TextDecoder, no Buffer — see header)
// ---------------------------------------------------------------------------

/**
 * A real, RFC 3629-conformant UTF-8 decoder: rejects truncated sequences,
 * invalid continuation bytes, overlong encodings, surrogate-half code
 * points and out-of-range code points — the same "fatal" semantics as
 * `new TextDecoder('utf-8', { fatal: true })`, implemented without
 * `TextDecoder` or `Buffer`. Throws on any malformed input; callers treat
 * that as "not a valid payload" and never propagate the throw past this
 * module's own `parseElectionBlockPayload`, which never throws.
 */
export function decodeUtf8Fatal (bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const len = bytes.length
  while (i < len) {
    const b0 = bytes[i]!
    let codePoint: number
    let extraBytes: number
    let minCodePoint: number
    if (b0 <= 0x7f) {
      codePoint = b0
      extraBytes = 0
      minCodePoint = 0
    } else if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f
      extraBytes = 1
      minCodePoint = 0x80
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f
      extraBytes = 2
      minCodePoint = 0x800
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07
      extraBytes = 3
      minCodePoint = 0x10000
    } else {
      throw new Error('decodeUtf8Fatal: invalid leading byte')
    }
    if (i + extraBytes >= len) {
      throw new Error('decodeUtf8Fatal: truncated sequence')
    }
    for (let j = 1; j <= extraBytes; j++) {
      const b = bytes[i + j]!
      if ((b & 0xc0) !== 0x80) throw new Error('decodeUtf8Fatal: invalid continuation byte')
      codePoint = (codePoint << 6) | (b & 0x3f)
    }
    if (codePoint < minCodePoint) throw new Error('decodeUtf8Fatal: overlong encoding')
    if (codePoint > 0x10ffff) throw new Error('decodeUtf8Fatal: code point out of range')
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error('decodeUtf8Fatal: surrogate code point')
    out += String.fromCodePoint(codePoint)
    i += extraBytes + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Serialize / parse (D-18 wire shape: fixed member order v, votes, voterRecords)
// ---------------------------------------------------------------------------

export function serializeElectionBlockPayload (payload: ElectionBlockPayload): Uint8Array {
  const json = JSON.stringify({ v: payload.v, votes: payload.votes, voterRecords: payload.voterRecords })
  return utf8ToBytes(json)
}

/**
 * Strict and NEVER throws. Returns `null` for anything that is not exactly
 * `{ v: 1 | 2, votes: unknown[], voterRecords: unknown[] }` — non-UTF-8 bytes,
 * non-JSON text, a non-object, an unknown version, a missing or non-array
 * `votes`/`voterRecords`, or an extra top-level member. A `v: 2` payload must
 * also carry every vote as a string (a `BlockCiphertext` JSON per vote).
 */
export function parseElectionBlockPayload (bytes: Uint8Array): ElectionBlockPayload | null {
  if (!(bytes instanceof Uint8Array)) return null
  let text: string
  try {
    text = decodeUtf8Fatal(bytes)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (Object.keys(obj).length !== 3) return null
  if (obj.v !== 1 && obj.v !== 2) return null
  if (!Array.isArray(obj.votes)) return null
  if (!Array.isArray(obj.voterRecords)) return null
  if (obj.v === 2 && !obj.votes.every((v) => typeof v === 'string')) return null
  return { v: obj.v, votes: obj.votes, voterRecords: obj.voterRecords }
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt (D-18 over 62-04's block cipher)
// ---------------------------------------------------------------------------

/**
 * Throws `BlockCipherError('invalid-plaintext')` BEFORE any encryption when
 * `payload` does not carry both `votes` and `voterRecords` as arrays (D-18:
 * a block builder can never encrypt votes without their voter records, or
 * vice versa).
 */
export function encryptElectionBlock (
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  blockId: string,
  payload: ElectionBlockPayload
): BlockCiphertext {
  if (
    payload === null || typeof payload !== 'object' || (payload.v !== 1 && payload.v !== 2) ||
    !Array.isArray(payload.votes) || !Array.isArray(payload.voterRecords) ||
    (payload.v === 2 && !payload.votes.every((v) => typeof v === 'string'))
  ) {
    throw new BlockCipherError(
      'invalid-plaintext',
      'encryptElectionBlock: payload must carry both votes and voterRecords arrays (D-18) — refused before encryption'
    )
  }
  const bytes = serializeElectionBlockPayload(payload)
  const binding: BlockCipherBinding = { electionId: electionKey.electionId, revision: electionKey.revision, blockId }
  return encryptBlockContent(electionKey.jointPublicKey, bytes, binding)
}

/**
 * Never throws. Decrypts and parses in one step, mapping every failure
 * reason through unchanged from `decryptBlockContent`, plus the
 * `'malformed-payload'` reason this module adds when the decrypted bytes do
 * not parse as a valid `ElectionBlockPayload`. The caller (`KeyReleaseEngine`)
 * is responsible for having already verified `secretKey`'s public key
 * equals the published `ElectionKey.JointPublicKey` — this function is never
 * handed Y, only `secretKey`, so it cannot make that assertion itself (see
 * header).
 */
export function openElectionBlock (
  secretKey: Uint8Array,
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  block: ElectionBlockInput
): ElectionBlockDecryptResult {
  const binding: BlockCipherBinding = { electionId: electionKey.electionId, revision: electionKey.revision, blockId: block.blockId }
  const result = decryptBlockContent(secretKey, block.ciphertext, binding)
  if (!result.ok) {
    return { ok: false, blockId: block.blockId, reason: result.reason, detail: result.detail }
  }
  const payload = parseElectionBlockPayload(result.plaintext)
  if (payload === null) {
    return {
      ok: false,
      blockId: block.blockId,
      reason: 'malformed-payload',
      detail: 'openElectionBlock: decrypted plaintext is not a valid ElectionBlockPayload — carries no plaintext'
    }
  }
  return { ok: true, blockId: block.blockId, payload }
}

// ---------------------------------------------------------------------------
// Pool-formed blocks (spike 102): votes encrypted one by one, block randomness disclosed
// ---------------------------------------------------------------------------

/**
 * The cipher binding for ONE vote entry encrypted on its own (payload `v: 2`). Its `blockId`
 * is `vote-entry/<ballotId>`: a block id is a base64url digest and never contains `/`, so a
 * vote ciphertext can never be passed off as a block ciphertext or the other way round.
 */
export function voteEntryBinding (
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision'>,
  ballotId: string
): BlockCipherBinding {
  return { electionId: electionKey.electionId, revision: electionKey.revision, blockId: `vote-entry/${ballotId}` }
}

/**
 * Encrypt one vote entry to Y on its own, before it leaves the phone. The voter who forms the
 * block then holds only this ciphertext: it cannot read the vote, and it cannot alter it without
 * the owner noticing (the owner checks its ciphertext is in the block byte for byte). What it CAN
 * still do is remember which member handed it which ciphertext, and so read the link once the key
 * is released — the accepted cost of this design (user decision, spike 102).
 *
 * Returns the serialized `BlockCiphertext` JSON, the exact string the block payload carries.
 */
export function encryptVoteEntry (
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  ballotId: string,
  voteEntryJson: string
): string {
  if (typeof voteEntryJson !== 'string' || voteEntryJson.length === 0) {
    throw new BlockCipherError('invalid-plaintext', 'encryptVoteEntry: the vote entry must be non-empty JSON text')
  }
  const ct = encryptBlockContent(electionKey.jointPublicKey, utf8ToBytes(voteEntryJson), voteEntryBinding(electionKey, ballotId))
  return JSON.stringify({ v: ct.v, alg: ct.alg, eph: ct.eph, nonce: ct.nonce, kc: ct.kc, ct: ct.ct })
}

/** One opened vote of a `v: 2` block. Never throws; a vote that fails to open says why. */
export type OpenedVoteEntry =
  | { ok: true, voteEntryJson: string }
  | { ok: false, reason: string, detail: string }

/**
 * After the key release: open every per-vote ciphertext of a `v: 2` payload. The caller has
 * already opened the block itself with `openElectionBlock` and checked the secret against Y.
 */
export function openVoteEntries (
  secretKey: Uint8Array,
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  ballotId: string,
  payload: ElectionBlockPayload
): OpenedVoteEntry[] {
  if (payload.v !== 2) return []
  const binding = voteEntryBinding(electionKey, ballotId)
  return payload.votes.map((vote): OpenedVoteEntry => {
    const result = decryptBlockContent(secretKey, vote, binding)
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }
    try {
      return { ok: true, voteEntryJson: decodeUtf8Fatal(result.plaintext) }
    } catch {
      return { ok: false, reason: 'malformed-payload', detail: 'openVoteEntries: a decrypted vote is not UTF-8' }
    }
  })
}

/** The block randomness a pool's former discloses so every member can re-derive the ciphertext. */
export interface DisclosedBlockRandomness {
  /** hex secp256k1 scalar */
  eph: string
  /** hex 12-byte nonce */
  nonce: string
}

function toRandomness (r: DisclosedBlockRandomness): BlockCipherRandomness {
  return { ephemeralSecretKey: hexToBytes(r.eph), nonce: hexToBytes(r.nonce) }
}

function hexToBytes (hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new TypeError('hexToBytes: not lowercase hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHexLower (bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Encrypt a pool-formed (`v: 2`) block with FRESH CSPRNG randomness and return that randomness
 * too, so the former can disclose it in `form` and each member can check the stored ciphertext
 * really encrypts the payload it was shown (`reencryptElectionBlock`). Disclosing it lets a member
 * open this one block before the key release; that reveals nothing new, because a `v: 2` payload
 * holds only per-vote ciphertexts (still sealed to Y) and voter entries the members already saw.
 * Refuses a `v: 1` payload: disclosing the randomness of a block of clear votes would hand every
 * member every vote.
 */
export function encryptPoolBlock (
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  blockId: string,
  payload: ElectionBlockPayload
): { ciphertext: BlockCiphertext, randomness: DisclosedBlockRandomness } {
  if (payload?.v !== 2) {
    throw new BlockCipherError('invalid-plaintext', 'encryptPoolBlock: only a v: 2 payload (per-vote ciphertexts) may have its randomness disclosed')
  }
  const randomness: DisclosedBlockRandomness = {
    eph: bytesToHexLower(secp256k1.utils.randomSecretKey()),
    nonce: bytesToHexLower(randomBytes(12))
  }
  return { ciphertext: reencryptElectionBlock(electionKey, blockId, payload, randomness), randomness }
}

/** Re-derive a pool block's ciphertext from its payload and the disclosed randomness. Throws on bad input. */
export function reencryptElectionBlock (
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>,
  blockId: string,
  payload: ElectionBlockPayload,
  randomness: DisclosedBlockRandomness
): BlockCiphertext {
  if (payload?.v !== 2) {
    throw new BlockCipherError('invalid-plaintext', 'reencryptElectionBlock: only a v: 2 payload is re-derivable')
  }
  if (!payload.votes.every((v) => typeof v === 'string') || !Array.isArray(payload.voterRecords)) {
    throw new BlockCipherError('invalid-plaintext', 'reencryptElectionBlock: a v: 2 payload carries string votes and a voterRecords array')
  }
  const binding: BlockCipherBinding = { electionId: electionKey.electionId, revision: electionKey.revision, blockId }
  return encryptBlockContentWithRandomness(electionKey.jointPublicKey, serializeElectionBlockPayload(payload), binding, toRandomness(randomness))
}
