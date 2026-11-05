// pairing-statement.ts — the officer-signed pairing statement and its verifiers (D-26).
//
// An officer's phone signs a statement that names the officer, a one-time nonce, an expiry and the
// identity peerId of the phone asking for the mint. The same statement travels inside the pairing
// code a browser later redeems. This file owns the ONLY definition of the two digests (the
// single-digest-definition rule, as `getRevokeKeyDigest` does for key revocation): the signing side
// calls `pairingStatementDigest` / `pairingRemoveDigest`, the verifying side evaluates the same SQL
// text, so the two can never drift. The signature is checked by the schema's own `SignatureValidP256`
// and `SignatureValid` functions, never by a verifier written here.
//
// `checkExpiry` is true at pairing and mint time and false on a per-pass re-check: a statement ages
// out of use, but a browser that was paired in time must not be unpaired just because the statement
// is old. The per-pass rule also keeps the plain "any Officer row" test: a join against the current
// administration would fail closed on browser clock skew and wipe a good browser. The stricter
// mint-time test is `isCurrentPairingOfficer`, called only by the owner phone on its own clock.
//
// Browser-pure: type-only database import and `../utils.js`. No clock (time arrives as
// `nowCanonical`), no logging, and every error is a fixed string.

import type { Database } from '@quereus/quereus'
import { digestToBytes } from '../utils.js'

export const PAIRING_DIGEST_TAG = 'vt-pairing'
export const PAIRING_REMOVE_DIGEST_TAG = 'vt-pairing-remove'

/** The statement a verifier checks; structurally the same as a decoded pairing code's statement. */
export interface VerifiablePairingStatement {
  userId: string
  nonce: string
  expiresAt: string
  requesterPeerId: string
  keyPub: string
  sig: string
}

export type PairingVerifyFailure = 'not-officer' | 'key-not-current' | 'bad-signature' | 'expired'
export type PairingVerifyResult = { ok: true } | { ok: false, reason: PairingVerifyFailure }

// The two digest expressions, typed once. The digest is text only: no datetime column enters it.
// requesterPeerId is appended LAST in the statement form.
const STATEMENT_DIGEST_EXPR =
  `Digest('${PAIRING_DIGEST_TAG}', :pairNetworkHash, :pairUserId, :pairNonce, :pairExpiresAt, :pairRequesterPeerId)`
const REMOVE_DIGEST_EXPR =
  `Digest('${PAIRING_REMOVE_DIGEST_TAG}', :pairNetworkHash, :pairUserId, :pairNonce, :pairPeerId, :pairExpiresAt)`

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/
const KEY_RE = /^[0-9a-fA-F]{2,256}$/
const SIG_RE = /^[0-9a-fA-F]{2,512}$/
const PEER_RE = /^[A-Za-z0-9]{1,128}$/

function idOk (v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128
}

function matches (re: RegExp, v: unknown): v is string {
  return typeof v === 'string' && re.test(v)
}

async function runDigest (db: Database, expr: string, binds: Record<string, string>): Promise<Uint8Array> {
  const row = await db.prepare(`select ${expr} as d`).get(binds)
  if (!row || row.d == null) throw new Error('pairing digest unavailable')
  return digestToBytes(row.d)
}

/** The bytes a device signer signs for a pairing statement. */
export async function pairingStatementDigest (
  db: Database,
  f: { networkHash: string, userId: string, nonce: string, expiresAt: string, requesterPeerId: string }
): Promise<Uint8Array> {
  return await runDigest(db, STATEMENT_DIGEST_EXPR, {
    pairNetworkHash: f.networkHash,
    pairUserId: f.userId,
    pairNonce: f.nonce,
    pairExpiresAt: f.expiresAt,
    pairRequesterPeerId: f.requesterPeerId
  })
}

/** The bytes a device signer signs to remove a paired browser's machine. */
export async function pairingRemoveDigest (
  db: Database,
  f: { networkHash: string, userId: string, nonce: string, peerId: string, expiresAt: string }
): Promise<Uint8Array> {
  return await runDigest(db, REMOVE_DIGEST_EXPR, {
    pairNetworkHash: f.networkHash,
    pairUserId: f.userId,
    pairNonce: f.nonce,
    pairPeerId: f.peerId,
    pairExpiresAt: f.expiresAt
  })
}

interface OfficerSignatureArgs {
  digestExpr: string
  binds: Record<string, string>
  userId: string
  keyPub: string
  sig: string
  expiresAt: string
  nowCanonical: string
  checkExpiry: boolean
}

async function verifyOfficerSignature (db: Database, a: OfficerSignatureArgs): Promise<PairingVerifyResult> {
  const bad: PairingVerifyResult = { ok: false, reason: 'bad-signature' }
  if (!matches(CANONICAL_RE, a.expiresAt) || !matches(CANONICAL_RE, a.nowCanonical)) return bad
  if (!matches(KEY_RE, a.keyPub) || !matches(SIG_RE, a.sig) || !idOk(a.userId)) return bad
  if (a.checkExpiry && a.expiresAt <= a.nowCanonical) return { ok: false, reason: 'expired' }
  try {
    const officer = await db.prepare('select 1 as x from Officer where UserId = :pairUserId').get({ pairUserId: a.userId })
    if (!officer) return { ok: false, reason: 'not-officer' }
    const key = await db
      .prepare("select coalesce(Type, 'M') as kt from UserKey where UserId = :pairUserId and PubKey = :pairKeyPub and Expiration > :nowAt")
      .get({ pairUserId: a.userId, pairKeyPub: a.keyPub, nowAt: a.nowCanonical })
    if (!key) return { ok: false, reason: 'key-not-current' }
    const fn = key.kt === 'P' ? 'SignatureValidP256' : 'SignatureValid'
    const binds = { ...a.binds, pairSig: a.sig, pairKeyPub: a.keyPub }
    const row = await db.prepare(`select ${fn}(${a.digestExpr}, :pairSig, :pairKeyPub) as ok`).get(binds)
    return row && (row.ok === true || row.ok === 1) ? { ok: true } : bad
  } catch {
    return bad
  }
}

/**
 * Verify a pairing statement for `networkHash`. Never throws: malformed input is `bad-signature`.
 */
export async function verifyPairingStatement (
  db: Database,
  args: { networkHash: string, statement: VerifiablePairingStatement, nowCanonical: string, checkExpiry: boolean }
): Promise<PairingVerifyResult> {
  const s = args?.statement
  const bad: PairingVerifyResult = { ok: false, reason: 'bad-signature' }
  if (s == null || typeof s !== 'object') return bad
  if (!idOk(args.networkHash) || !idOk(s.userId) || !matches(NONCE_RE, s.nonce) || !matches(PEER_RE, s.requesterPeerId)) return bad
  return await verifyOfficerSignature(db, {
    digestExpr: STATEMENT_DIGEST_EXPR,
    binds: {
      pairNetworkHash: args.networkHash,
      pairUserId: s.userId,
      pairNonce: s.nonce,
      pairExpiresAt: s.expiresAt,
      pairRequesterPeerId: s.requesterPeerId
    },
    userId: s.userId,
    keyPub: s.keyPub,
    sig: s.sig,
    expiresAt: s.expiresAt,
    nowCanonical: args.nowCanonical,
    checkExpiry: args.checkExpiry === true
  })
}

/**
 * Verify a remove request. Its expiry is always checked. The remove digest does not bind the
 * requesting phone, so an officer can remove their own browsers from any of their phones.
 */
export async function verifyPairingRemove (
  db: Database,
  args: {
    networkHash: string
    request: { userId: string, nonce: string, peerId: string, expiresAt: string, keyPub: string, sig: string }
    nowCanonical: string
  }
): Promise<PairingVerifyResult> {
  const r = args?.request
  const bad: PairingVerifyResult = { ok: false, reason: 'bad-signature' }
  if (r == null || typeof r !== 'object') return bad
  if (!idOk(args.networkHash) || !idOk(r.userId) || !matches(NONCE_RE, r.nonce) || !matches(PEER_RE, r.peerId)) return bad
  return await verifyOfficerSignature(db, {
    digestExpr: REMOVE_DIGEST_EXPR,
    binds: {
      pairNetworkHash: args.networkHash,
      pairUserId: r.userId,
      pairNonce: r.nonce,
      pairPeerId: r.peerId,
      pairExpiresAt: r.expiresAt
    },
    userId: r.userId,
    keyPub: r.keyPub,
    sig: r.sig,
    expiresAt: r.expiresAt,
    nowCanonical: args.nowCanonical,
    checkExpiry: true
  })
}

/**
 * Mint-time officer test: true only when an Officer row for `userId` belongs to its authority's
 * administration in effect at `nowCanonical`. It mirrors the `CurrentAdmin` view with the owner's
 * clock bound in, and it is for mint time only. It fails closed: a malformed input, a missing
 * Admin row or a failed query is false.
 */
export async function isCurrentPairingOfficer (
  db: Database,
  args: { userId: string, nowCanonical: string }
): Promise<boolean> {
  if (!idOk(args?.userId) || !matches(CANONICAL_RE, args.nowCanonical)) return false
  try {
    const row = await db
      .prepare('select 1 as x from Officer O where O.UserId = :pairUserId and O.AdminEffectiveAt = (select max(A.EffectiveAt) from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= :nowAt)')
      .get({ pairUserId: args.userId, nowAt: args.nowCanonical })
    return row !== undefined && row !== null
  } catch {
    return false
  }
}
