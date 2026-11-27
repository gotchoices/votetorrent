// src/pairing/pairing-code.ts — the `vtpair1.` pairing code: the text the Authority app shows
// (copy, share, QR) and the dashboard accepts (paste, webcam scan) to pair a browser to an
// officer's phone.
//
// The code is a bearer credential for about 15 minutes, single use through its inner
// invitation (D-06, D-23). It carries two things in one string:
//
//   * a pairing statement header: who the officer claims to be (userId), which phone asked
//     (requesterPeerId), a nonce, an expiry, the officer's signing public key and the
//     signature over the statement digest;
//   * the network admission: a `vtjoin2.` join code, verbatim.
//
// Wire form:  'vtpair1.' + base64url(ASCII JSON {"v":1,"userId","requesterPeerId","nonce",
//             "expiresAt","keyPub","sig"}) + '.' + the vtjoin2. code
//
// There is no double encoding. The join code rides verbatim after a second '.', which avoids
// the roughly 33% base64 inflation of nesting it inside JSON; that is what keeps the code
// under PAIRING_QR_BYTE_BUDGET. The header JSON is pure ASCII (non-ASCII escaped as \uXXXX),
// so neither the Hermes encoder nor the browser decoder needs a UTF-8 codec; ASCII JSON is
// valid UTF-8 JSON. The addresses of D-18 live in the inner invitation's `members` and survive
// untouched because the join code is not re-encoded.
//
// The decoded statement is UNVERIFIED: authenticity is `verifyPairingStatement` (66-03), and
// the caller decodes the inner join code with `decodeNetworkJoinCode`. requesterPeerId binds
// the statement to the requesting phone's identity peerId (ruling R-A); the owner checks it,
// this codec only carries and shape-checks it.
//
// Hygiene: this file has no console, and every thrown message is a fixed string that never
// includes any input.

import { bytesToBase64url } from '../utils.js'
import { decodeNetworkJoinCode, NETWORK_JOIN_CODE_PREFIX_V2 } from '../networks/join-code.js'

export const PAIRING_CODE_PREFIX = 'vtpair1.'
/** QR version 40, error correction level L, byte mode. */
export const PAIRING_QR_BYTE_BUDGET = 2953
/** Decode cap, applied after whitespace removal. */
export const PAIRING_CODE_MAX_CHARS = 6144

/** Checked before whitespace removal, so an enormous paste is refused without being scanned. */
const RAW_INPUT_MAX_CHARS = 4 * PAIRING_CODE_MAX_CHARS
const MAX_HEADER_CHARS = 2048
const PAIRING_PREFIX_PATTERN = /^vtpair(\d+)\./
/** The Phase 50 sign-in code shape: 40 lowercase hex, a dot, 43 base64url chars. */
const OLD_STYLE_SIGNIN_PATTERN = /^[0-9a-f]{40}\.[A-Za-z0-9_-]{43}$/
const JOIN_PART_PATTERN = new RegExp('^' + NETWORK_JOIN_CODE_PREFIX_V2.replace('.', '\\.') + '[A-Za-z0-9_-]+$')
const STATEMENT_KEYS = ['expiresAt', 'keyPub', 'nonce', 'requesterPeerId', 'sig', 'userId', 'v'] as const
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export interface PairingStatement {
  readonly userId: string
  /** The requesting officer phone's identity peerId, as `peerId.toString()` gives (base58btc). */
  readonly requesterPeerId: string
  /** 16 random bytes, unpadded base64url (22 chars). */
  readonly nonce: string
  /** 19-char canonical datetime, no fraction, no `Z`. */
  readonly expiresAt: string
  /** The `UserKey.PubKey` text form: hex SEC1, 66 compressed or 130 uncompressed chars. */
  readonly keyPub: string
  /** Hex signature text: compact 128, or DER up to 144. */
  readonly sig: string
}

export interface DecodedPairingCode {
  readonly statement: PairingStatement
  readonly joinCode: string
}

export type PairingCodeFailure = 'malformed' | 'unsupported-version' | 'not-pairing-code' | 'old-style-code'

const FAILURE_MESSAGES: Readonly<Record<PairingCodeFailure, string>> = Object.freeze({
  malformed: 'pairing code: malformed',
  'unsupported-version': 'pairing code: unsupported version',
  'not-pairing-code': 'pairing code: not a pairing code',
  'old-style-code': 'pairing code: old-style sign-in code'
})

export class PairingCodeError extends Error {
  readonly reason: PairingCodeFailure
  constructor (reason: PairingCodeFailure) {
    super(FAILURE_MESSAGES[reason])
    this.name = 'PairingCodeError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------------------------
// field validators

const isStr = (v: unknown): v is string => typeof v === 'string'
const validUserId = (v: unknown): v is string => isStr(v) && v.length >= 1 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v)
const validPeerId = (v: unknown): v is string => isStr(v) && v.length >= 1 && v.length <= 128 && /^[\x21-\x7e]+$/.test(v)
const validNonce = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9_-]{22}$/.test(v)
const validExpiresAt = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)
const validKeyPub = (v: unknown): v is string => isStr(v) && (v.length === 66 || v.length === 130) && /^[0-9a-fA-F]+$/.test(v)
const validSig = (v: unknown): v is string => isStr(v) && v.length >= 16 && v.length <= 288 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v)

function statementWellFormed (s: unknown): s is PairingStatement {
  if (s === null || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return validUserId(o.userId) && validPeerId(o.requesterPeerId) && validNonce(o.nonce) &&
    validExpiresAt(o.expiresAt) && validKeyPub(o.keyPub) && validSig(o.sig)
}

// ---------------------------------------------------------------------------------------------
// ASCII helpers (the join-code.ts approach)

function asciiJson (value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function decodeBase64urlAscii (text: string): string | null {
  let out = ''
  let acc = 0
  let bits = 0
  for (const ch of text) {
    const v = BASE64URL_ALPHABET.indexOf(ch)
    if (v < 0) return null
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      const byte = (acc >> bits) & 0xff
      if (byte > 0x7f) return null // the encoder only ever writes ASCII
      out += String.fromCharCode(byte)
    }
  }
  return out
}

function asciiToBytes (text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function hasExactKeys (obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

// ---------------------------------------------------------------------------------------------
// encoder

/** Encode a pairing code. Throws a plain Error only on input that would not decode (a programming error). */
export function encodePairingCode (parts: { statement: PairingStatement, joinCode: string }): string {
  const statement = parts?.statement
  if (!statementWellFormed(statement)) throw new Error('encodePairingCode: the statement is not well formed')
  const joinCode = parts.joinCode
  if (!isStr(joinCode) || !JOIN_PART_PATTERN.test(joinCode) || !decodeNetworkJoinCode(joinCode).ok) {
    throw new Error('encodePairingCode: the join code does not decode')
  }
  const header = bytesToBase64url(asciiToBytes(asciiJson({
    v: 1,
    userId: statement.userId,
    requesterPeerId: statement.requesterPeerId,
    nonce: statement.nonce,
    expiresAt: statement.expiresAt,
    keyPub: statement.keyPub,
    sig: statement.sig
  })))
  const result = PAIRING_CODE_PREFIX + header + '.' + joinCode
  let ok = false
  try {
    const back = decodePairingCode(result)
    ok = back.joinCode === joinCode &&
      back.statement.userId === statement.userId &&
      back.statement.requesterPeerId === statement.requesterPeerId &&
      back.statement.nonce === statement.nonce &&
      back.statement.expiresAt === statement.expiresAt &&
      back.statement.keyPub === statement.keyPub &&
      back.statement.sig === statement.sig
  } catch {
    ok = false
  }
  if (!ok) throw new Error('encodePairingCode: the code does not decode')
  return result
}

// ---------------------------------------------------------------------------------------------
// decoder

/** Decode a pairing code. Throws `PairingCodeError` only. The statement is UNVERIFIED. */
export function decodePairingCode (text: unknown): DecodedPairingCode {
  if (!isStr(text)) throw new PairingCodeError('malformed')
  if (text.length > RAW_INPUT_MAX_CHARS) throw new PairingCodeError('malformed')
  const compact = text.replace(/\s+/g, '')
  if (compact.length > PAIRING_CODE_MAX_CHARS) throw new PairingCodeError('malformed')
  if (OLD_STYLE_SIGNIN_PATTERN.test(compact)) throw new PairingCodeError('old-style-code')
  const m = PAIRING_PREFIX_PATTERN.exec(compact)
  if (m === null) throw new PairingCodeError('not-pairing-code')
  if (m[1] !== '1') throw new PairingCodeError('unsupported-version')

  const rest = compact.slice(m[0].length)
  const sep = rest.indexOf('.')
  if (sep < 0) throw new PairingCodeError('malformed')
  const headerText = rest.slice(0, sep)
  const joinCode = rest.slice(sep + 1)
  if (headerText.length === 0 || headerText.length > MAX_HEADER_CHARS) throw new PairingCodeError('malformed')
  if (!JOIN_PART_PATTERN.test(joinCode)) throw new PairingCodeError('malformed')

  const json = decodeBase64urlAscii(headerText)
  if (json === null) throw new PairingCodeError('malformed')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new PairingCodeError('malformed')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PairingCodeError('malformed')
  const o = parsed as Record<string, unknown>
  if (typeof o.v === 'number' && o.v !== 1) throw new PairingCodeError('unsupported-version')
  if (o.v !== 1 || !hasExactKeys(o, STATEMENT_KEYS)) throw new PairingCodeError('malformed')
  if (!statementWellFormed(o)) throw new PairingCodeError('malformed')
  return {
    statement: {
      userId: o.userId as string,
      requesterPeerId: o.requesterPeerId as string,
      nonce: o.nonce as string,
      expiresAt: o.expiresAt as string,
      keyPub: o.keyPub as string,
      sig: o.sig as string
    },
    joinCode
  }
}
