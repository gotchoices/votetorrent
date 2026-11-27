// src/keyholder/dkg-payloads.ts — the `KeyholderDkgMessage.Payload` wire
// shapes for each DKG round (62-17: D-19). PURE: imports only from
// `../crypto/dkg.js` (types), `@noble/hashes/utils.js` and this module's own
// code. No DB, no `node:`, no `Buffer`, no `console` — see `sealed-payload.ts`'s
// header for the purity discipline this module follows.
//
// Every `parseRound{N}Payload` is NEVER-THROWING: malformed input (wrong
// shape, bad hex, wrong length, unsorted roster, duplicate members, an empty
// complaint list, extra/missing members) returns `null` rather than
// throwing. Every `serializeRound{N}Payload` builds its object with a FIXED
// member order so the JSON text — and therefore the signed Digest — is
// reproducible byte-for-byte across callers.

import type { ComplaintEvidence, DkgRound1Wire, EncryptedShare } from '../crypto/dkg.js'

// ---------------------------------------------------------------------------
// Shared structural helpers
// ---------------------------------------------------------------------------

function isHexOfLength (value: unknown, len: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${len}}$`).test(value)
}

function isPointHex (value: unknown): value is string {
  return isHexOfLength(value, 66) && (value.startsWith('02') || value.startsWith('03'))
}

function isIdentifierHex (value: unknown): value is string {
  return isHexOfLength(value, 64)
}

function isSortedUniqueRoster (value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) return false
  }
  for (let i = 1; i < value.length; i++) {
    if (!(value[i - 1] < value[i])) return false
  }
  return true
}

function isPositiveInt (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseJson (text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function hasExactKeys (obj: Record<string, unknown>, keys: string[]): boolean {
  const objKeys = Object.keys(obj)
  if (objKeys.length !== keys.length) return false
  return keys.every((k) => objKeys.includes(k))
}

function isDkgRound1Wire (value: unknown): value is DkgRound1Wire {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (!hasExactKeys(obj, ['identifier', 'commitment', 'proofOfKnowledge'])) return false
  if (!isIdentifierHex(obj.identifier)) return false
  if (!Array.isArray(obj.commitment) || obj.commitment.length === 0) return false
  for (const c of obj.commitment) if (!isPointHex(c)) return false
  if (!isHexOfLength(obj.proofOfKnowledge, 130)) return false
  return true
}

function isEncryptedShare (value: unknown): value is EncryptedShare {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (!hasExactKeys(obj, ['v', 'dealer', 'recipient', 'ephemeralPublicKey', 'nonce', 'ciphertext', 'keyCommitment'])) return false
  if (obj.v !== 1) return false
  if (!isIdentifierHex(obj.dealer)) return false
  if (!isIdentifierHex(obj.recipient)) return false
  if (!isPointHex(obj.ephemeralPublicKey)) return false
  if (!isHexOfLength(obj.nonce, 24)) return false
  if (!isHexOfLength(obj.keyCommitment, 64)) return false
  if (typeof obj.ciphertext !== 'string' || obj.ciphertext.length === 0 || obj.ciphertext.length % 2 !== 0 || !/^[0-9a-f]*$/.test(obj.ciphertext)) return false
  return true
}

function isComplaintEvidence (value: unknown): value is ComplaintEvidence {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (!hasExactKeys(obj, ['dealer', 'recipient', 'sharedSecret'])) return false
  if (!isIdentifierHex(obj.dealer)) return false
  if (!isIdentifierHex(obj.recipient)) return false
  if (!isPointHex(obj.sharedSecret)) return false
  return true
}

// ---------------------------------------------------------------------------
// Round 0 — commit
// ---------------------------------------------------------------------------

export interface DkgRound0Payload {
  v: 1
  commit: string
  roster: string[]
  threshold: number
}

export function serializeRound0Payload (payload: DkgRound0Payload): string {
  return JSON.stringify({ v: 1, commit: payload.commit, roster: payload.roster, threshold: payload.threshold })
}

export function parseRound0Payload (text: string): DkgRound0Payload | null {
  const parsed = parseJson(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (!hasExactKeys(obj, ['v', 'commit', 'roster', 'threshold'])) return null
  if (obj.v !== 1) return null
  if (!isHexOfLength(obj.commit, 64)) return null
  if (!isSortedUniqueRoster(obj.roster)) return null
  if (!isPositiveInt(obj.threshold)) return null
  return { v: 1, commit: obj.commit, roster: obj.roster as string[], threshold: obj.threshold }
}

// ---------------------------------------------------------------------------
// Round 1 — reveal (DkgRound1Wire exactly)
// ---------------------------------------------------------------------------

export function serializeRound1Payload (payload: DkgRound1Wire): string {
  return JSON.stringify({ identifier: payload.identifier, commitment: payload.commitment, proofOfKnowledge: payload.proofOfKnowledge })
}

export function parseRound1Payload (text: string): DkgRound1Wire | null {
  const parsed = parseJson(text)
  if (!isDkgRound1Wire(parsed)) return null
  return parsed
}

// ---------------------------------------------------------------------------
// Round 2 — encrypted share bundle, sorted by recipient
// ---------------------------------------------------------------------------

export type DkgRound2Payload = EncryptedShare[]

export function serializeRound2Payload (payload: EncryptedShare[]): string {
  const sorted = [...payload].sort((a, b) => (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0))
  return JSON.stringify(sorted.map((e) => ({
    v: 1,
    dealer: e.dealer,
    recipient: e.recipient,
    ephemeralPublicKey: e.ephemeralPublicKey,
    nonce: e.nonce,
    ciphertext: e.ciphertext,
    keyCommitment: e.keyCommitment
  })))
}

export function parseRound2Payload (text: string): DkgRound2Payload | null {
  const parsed = parseJson(text)
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const out: EncryptedShare[] = []
  const seenRecipients = new Set<string>()
  const dealer = (parsed[0] as Record<string, unknown> | undefined)?.dealer
  for (const entry of parsed) {
    if (!isEncryptedShare(entry)) return null
    if (entry.dealer !== dealer) return null
    if (seenRecipients.has(entry.recipient)) return null
    seenRecipients.add(entry.recipient)
    out.push(entry)
  }
  // must be sorted by recipient
  for (let i = 1; i < out.length; i++) {
    if (!(out[i - 1]!.recipient < out[i]!.recipient)) return null
  }
  return out
}

// ---------------------------------------------------------------------------
// Round 3 — ack or complaint
// ---------------------------------------------------------------------------

export interface DkgRound3AckPayload { v: 1, kind: 'ack' }
export interface DkgRound3ComplaintPayload { v: 1, kind: 'complaint', evidence: ComplaintEvidence[] }
export type DkgRound3Payload = DkgRound3AckPayload | DkgRound3ComplaintPayload

export function serializeRound3Payload (payload: DkgRound3Payload): string {
  if (payload.kind === 'ack') return JSON.stringify({ v: 1, kind: 'ack' })
  return JSON.stringify({ v: 1, kind: 'complaint', evidence: payload.evidence })
}

export function parseRound3Payload (text: string): DkgRound3Payload | null {
  const parsed = parseJson(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 1) return null
  if (obj.kind === 'ack') {
    if (!hasExactKeys(obj, ['v', 'kind'])) return null
    return { v: 1, kind: 'ack' }
  }
  if (obj.kind === 'complaint') {
    if (!hasExactKeys(obj, ['v', 'kind', 'evidence'])) return null
    if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) return null
    const evidence: ComplaintEvidence[] = []
    for (const e of obj.evidence) {
      if (!isComplaintEvidence(e)) return null
      evidence.push(e)
    }
    return { v: 1, kind: 'complaint', evidence }
  }
  return null
}

// ---------------------------------------------------------------------------
// Round 4 — result
// ---------------------------------------------------------------------------

export interface DkgRound4Payload { groupPublicKey: string, groupCommitments: string[] }

export function serializeRound4Payload (payload: DkgRound4Payload): string {
  return JSON.stringify({ groupPublicKey: payload.groupPublicKey, groupCommitments: payload.groupCommitments })
}

export function parseRound4Payload (text: string): DkgRound4Payload | null {
  const parsed = parseJson(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (!hasExactKeys(obj, ['groupPublicKey', 'groupCommitments'])) return null
  if (!isPointHex(obj.groupPublicKey)) return null
  if (!Array.isArray(obj.groupCommitments) || obj.groupCommitments.length === 0) return null
  const commitments: string[] = []
  for (const c of obj.groupCommitments) {
    if (!isPointHex(c)) return null
    commitments.push(c)
  }
  return { groupPublicKey: obj.groupPublicKey, groupCommitments: commitments }
}

/**
 * Guarded parse of the `ElectionKey.GroupCommitments` column (a replicated, write-once value any live keyholder may
 * publish). Returns the commitment array, or `null` unless `text` is a string that parses to a non-empty array of
 * valid compressed secp256k1 points. NEVER throws: every reader treats `null` as "malformed on the row".
 */
export function parseElectionKeyCommitments (text: unknown): string[] | null {
  if (typeof text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const out: string[] = []
  for (const c of parsed) {
    if (!isPointHex(c)) return null
    out.push(c)
  }
  return out
}
