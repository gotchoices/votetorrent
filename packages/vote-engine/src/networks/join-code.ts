// src/networks/join-code.ts — spike 100 / phase 64: the text an authority hands a voter so the
// voter's phone can join the authority's network.
//
// A join code is a cadre invitation (cadre-core `encodeCadreInvitation`, already base64url)
// plus the network's founding anchor: the strand id, the four keys that select the six
// founding rows, and the digest those rows must hash to. The voter's phone redeems the
// invitation, opens the strand, and accepts the network only when the replicated founding
// rows hash to `digest` (`NetworksEngine.joinFromStrand`). The fingerprint a voter compares
// against the authority's published one is `foundingBundleFingerprint(digest)`, the same
// fingerprint a founding bundle shows.
//
// Two wire forms, both unpadded base64url of pure-ASCII JSON (every non-ASCII character is
// escaped as \uXXXX), so neither direction needs a UTF-8 codec: the phone runtime (Hermes) is
// not guaranteed a `TextDecoder` (election-block.ts's header).
//
//   `vtjoin1.` the invitation is a STRING (cadre-core's `sereus-invite:1.<base64url>` text), so
//              it is base64url-encoded twice. About 1.8 KB for a one-member invitation.
//   `vtjoin2.` (D-01) the invitation is a nested OBJECT with the same fields, so it is encoded
//              once; about a fifth shorter, which keeps the QR a smaller version. The decoder
//              rebuilds the exact `sereus-invite:1.` string cadre-core minted, so every caller
//              still sees `invitation: string`. Every string inside the invitation subtree must
//              be printable ASCII (real invitations are ASCII by construction), which is what
//              makes the byte-identical re-serialisation possible without a UTF-8 encoder.
//
// Caps (after whitespace removal): v2 4096 chars, v1 16,384; every v2 string 1024 or fewer.
// D-07: a text that is not a join code, a `vtjoin<N>.` of an unknown N, and a v1 code whose
// invitation is a 1.14-era no-prefix mint each get their own typed decode failure.
//
// D-06: the code is a bearer credential. This file has no console, and every thrown message
// is a fixed string that never includes input.

import type { NetworkJoinAnchor } from '@votetorrent/vote-core'
import { bytesToBase64url } from '../utils.js'
import { foundingBundleFingerprint } from './founding-bundle.js'

export const NETWORK_JOIN_CODE_PREFIX = 'vtjoin1.'
export const NETWORK_JOIN_CODE_PREFIX_V2 = 'vtjoin2.'
/**
 * cadre-core's `CADRE_INVITATION_PREFIX`. vote-engine never imports cadre-core (D-03), so the
 * literal is pinned to the real constant by
 * `apps/VoteTorrentAuthority/src/engines/__tests__/join-code-prefix.spec.ts`.
 */
export const CADRE_INVITATION_PREFIX_EXPECTED = 'sereus-invite:1.'

/** A join code's decoded content. */
export interface NetworkJoinCode extends NetworkJoinAnchor {
  readonly v: 1 | 2
  /**
   * cadre-core `encodeCadreInvitation` output. Opaque here: vote-engine never imports cadre-core
   * (D-03). A v2 code carries the invitation as a nested object on the wire; it is re-serialised
   * to this same string on decode.
   */
  readonly invitation: string
}

export type NetworkJoinCodeDecodeFailure = 'malformed' | 'unsupported-version' | 'invitation-older-version' | 'not-join-code'

export type NetworkJoinCodeDecodeResult =
  | { readonly ok: true; readonly code: NetworkJoinCode; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: NetworkJoinCodeDecodeFailure }

/** Bound on the v1 text a decoder will look at (a pasted v1 code is ~1.8 KB). */
const MAX_V1_CODE_CHARS = 16_384
/** Bound on the v2 text (six members with a long name still fit one QR code). */
const MAX_V2_CODE_CHARS = 4_096
/** Bound on every v2 string other than the display name. */
const MAX_FIELD_CHARS = 1_024
/** Bound on the display name (the Network row's own name wins once joined). */
const MAX_NAME_CHARS = 256
const MAX_OWNER_KEYS = 16
const MAX_INVITATION_MEMBERS = 8
const JOIN_CODE_PREFIX_PATTERN = /^vtjoin(\d+)\./

const TOP_KEYS = ['digest', 'genesis', 'invitation', 'name', 'networkHash', 'v'] as const
const GENESIS_KEYS = ['adminEffectiveAt', 'authorityId', 'signerKey', 'userId'] as const
const INVITATION_KEYS = ['invite', 'invitePrivateKey', 'members', 'ownerKeys', 'partyId', 'v'] as const
// cadre-core 1.18 dropped `grantsOwner` from the invite row (sereus ticket 2.4: an invitation never grants
// ownership), so the row's key set and its mint order (`ControlDatabase.signCadreInvite`) lost it.
const INVITE_KEYS = ['expiresAt', 'issuerKey', 'issuerSig', 'key', 'peerId', 'stampId', 'totalUses'] as const
/** The invite row's keys up to cadre-core 1.17: a code minted before the 1.18 upgrade, which cannot redeem on it. */
const PRE_118_INVITE_KEYS = ['expiresAt', 'grantsOwner', 'issuerKey', 'issuerSig', 'key', 'peerId', 'stampId', 'totalUses'] as const
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

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

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
/** A string of 1..1024 chars, all printable ASCII (rule R2 of the v2 form). */
const isWireString = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_FIELD_CHARS && /^[\x20-\x7e]+$/.test(v)
const isBoundedNonEmpty = (v: unknown): v is string => isNonEmptyString(v) && v.length <= MAX_FIELD_CHARS

/** True for text that starts a join code of ANY version (`vtjoin<N>.`), whitespace ignored. */
export function looksLikeJoinCode (text: unknown): boolean {
  return typeof text === 'string' && JOIN_CODE_PREFIX_PATTERN.test(text.replace(/\s+/g, ''))
}

/**
 * True only for a 1.14-era invitation: not cadre-core's `sereus-invite:1.` string, but bare
 * base64url JSON of an object with `v === 1` and a string `partyId`. Every other string stays
 * opaque to this file, exactly as before.
 */
export function isOlderVersionInvitation (invitation: string): boolean {
  if (invitation.startsWith(CADRE_INVITATION_PREFIX_EXPECTED)) return false
  const json = decodeBase64urlAscii(invitation)
  if (json === null) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return false
  }
  return isPlainObject(parsed) && parsed.v === 1 && typeof parsed.partyId === 'string'
}

/** Encode a join code. Throws only on a code that would not decode (a programming error). */
export function encodeNetworkJoinCode (code: NetworkJoinCode): string {
  let text: string
  if (code.v === 1) {
    const json = asciiJson({
      v: 1,
      invitation: code.invitation,
      networkHash: code.networkHash,
      name: code.name,
      genesis: genesisOf(code),
      digest: code.digest
    })
    text = NETWORK_JOIN_CODE_PREFIX + bytesToBase64url(asciiToBytes(json))
  } else if (code.v === 2) {
    if (typeof code.invitation !== 'string' || !code.invitation.startsWith(CADRE_INVITATION_PREFIX_EXPECTED)) {
      throw new Error('encodeNetworkJoinCode: the invitation is not a cadre invitation')
    }
    const invitationJson = decodeBase64urlAscii(code.invitation.slice(CADRE_INVITATION_PREFIX_EXPECTED.length))
    let invitation: unknown
    try {
      if (invitationJson === null) throw new Error('not base64url ASCII')
      invitation = JSON.parse(invitationJson)
    } catch {
      throw new Error('encodeNetworkJoinCode: the invitation is not a cadre invitation')
    }
    const json = asciiJson({
      v: 2,
      invitation,
      networkHash: code.networkHash,
      name: code.name,
      genesis: genesisOf(code),
      digest: code.digest
    })
    text = NETWORK_JOIN_CODE_PREFIX_V2 + bytesToBase64url(asciiToBytes(json))
    const back = decodeNetworkJoinCode(text)
    // The byte-identity self-check: the rebuilt invitation must equal cadre-core's own mint.
    if (!back.ok || back.code.v !== 2 || back.code.invitation !== code.invitation) {
      throw new Error('encodeNetworkJoinCode: the code does not decode')
    }
    return text
  } else {
    throw new Error('encodeNetworkJoinCode: unsupported version')
  }
  if (!decodeNetworkJoinCode(text).ok) throw new Error('encodeNetworkJoinCode: the code does not decode')
  return text
}

function genesisOf (code: NetworkJoinCode) {
  return {
    userId: code.genesis.userId,
    signerKey: code.genesis.signerKey,
    authorityId: code.genesis.authorityId,
    adminEffectiveAt: code.genesis.adminEffectiveAt
  }
}

const MALFORMED = { ok: false, reason: 'malformed' } as const

/**
 * Decode a pasted or scanned join code. Never throws. Surrounding whitespace (and line breaks a
 * chat app may insert) is ignored. Text with no `vtjoin<N>.` prefix is `not-join-code`; an N
 * other than 1 or 2 is `unsupported-version`; a v1 code whose invitation is a 1.14-era
 * no-prefix mint, or a v2 code whose invite row still carries the pre-1.18 `grantsOwner` field, is
 * `invitation-older-version`; anything else that is not exactly the encoder's
 * shape is `malformed`. A non-string input is `malformed`.
 */
export function decodeNetworkJoinCode (text: unknown): NetworkJoinCodeDecodeResult {
  if (typeof text !== 'string') return MALFORMED
  const compact = text.replace(/\s+/g, '')
  const match = JOIN_CODE_PREFIX_PATTERN.exec(compact)
  if (match === null) return { ok: false, reason: 'not-join-code' }
  const body = compact.slice(match[0].length)
  if (match[1] === '1') return decodeV1(compact.length, body)
  if (match[1] === '2') return decodeV2(compact.length, body)
  return { ok: false, reason: 'unsupported-version' }
}

function parseObject (body: string): Record<string, unknown> | null {
  const json = decodeBase64urlAscii(body)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return isPlainObject(parsed) ? parsed : null
}

function decodeV1 (compactLength: number, body: string): NetworkJoinCodeDecodeResult {
  if (compactLength > MAX_V1_CODE_CHARS) return MALFORMED
  const obj = parseObject(body)
  if (obj === null) return MALFORMED
  if (typeof obj.v === 'number' && obj.v !== 1) return { ok: false, reason: 'unsupported-version' }
  if (obj.v !== 1 || !hasExactKeys(obj, TOP_KEYS)) return MALFORMED
  if (!isNonEmptyString(obj.invitation) || !isNonEmptyString(obj.networkHash) || !isNonEmptyString(obj.digest)) return MALFORMED
  if (typeof obj.name !== 'string' || obj.name.length > MAX_NAME_CHARS) return MALFORMED
  const g = obj.genesis
  if (!isPlainObject(g)) return MALFORMED
  if (!hasExactKeys(g, GENESIS_KEYS) || !GENESIS_KEYS.every((k) => isNonEmptyString(g[k]))) return MALFORMED
  let fingerprint: string
  try {
    fingerprint = foundingBundleFingerprint(obj.digest)
  } catch {
    return MALFORMED
  }
  if (isOlderVersionInvitation(obj.invitation)) return { ok: false, reason: 'invitation-older-version' }
  return {
    ok: true,
    fingerprint,
    code: {
      v: 1,
      invitation: obj.invitation,
      networkHash: obj.networkHash,
      name: obj.name,
      genesis: {
        userId: g.userId as string,
        signerKey: g.signerKey as string,
        authorityId: g.authorityId as string,
        adminEffectiveAt: g.adminEffectiveAt as string
      },
      digest: obj.digest
    }
  }
}

function decodeV2 (compactLength: number, body: string): NetworkJoinCodeDecodeResult {
  if (compactLength > MAX_V2_CODE_CHARS) return MALFORMED
  const obj = parseObject(body)
  if (obj === null) return MALFORMED
  if (obj.v !== 2 || !hasExactKeys(obj, TOP_KEYS)) return MALFORMED
  if (!isBoundedNonEmpty(obj.networkHash) || !isBoundedNonEmpty(obj.digest)) return MALFORMED
  if (typeof obj.name !== 'string' || obj.name.length > MAX_NAME_CHARS) return MALFORMED
  const g = obj.genesis
  if (!isPlainObject(g)) return MALFORMED
  if (!hasExactKeys(g, GENESIS_KEYS) || !GENESIS_KEYS.every((k) => isBoundedNonEmpty(g[k]))) return MALFORMED
  const inv = obj.invitation
  if (!isPlainObject(inv) || !hasExactKeys(inv, INVITATION_KEYS)) return MALFORMED
  if (inv.v !== 1 || !isWireString(inv.partyId) || !isWireString(inv.invitePrivateKey)) return MALFORMED
  const invite = inv.invite
  if (isPlainObject(invite) && hasExactKeys(invite, PRE_118_INVITE_KEYS)) return { ok: false, reason: 'invitation-older-version' }
  if (!isPlainObject(invite) || !hasExactKeys(invite, INVITE_KEYS)) return MALFORMED
  if (!isWireString(invite.key) || !isWireString(invite.stampId) || !isWireString(invite.issuerKey) || !isWireString(invite.issuerSig)) {
    return MALFORMED
  }
  if (invite.peerId !== null && !isWireString(invite.peerId)) return MALFORMED
  if (invite.expiresAt !== null && !isWireString(invite.expiresAt)) return MALFORMED
  if (invite.totalUses !== null && !(typeof invite.totalUses === 'number' && Number.isSafeInteger(invite.totalUses) && invite.totalUses >= 1)) {
    return MALFORMED
  }
  const ownerKeys = inv.ownerKeys
  if (!Array.isArray(ownerKeys) || ownerKeys.length < 1 || ownerKeys.length > MAX_OWNER_KEYS || !ownerKeys.every(isWireString)) return MALFORMED
  const members = inv.members
  if (!Array.isArray(members) || members.length > MAX_INVITATION_MEMBERS || !members.every(isWireString)) return MALFORMED
  let fingerprint: string
  try {
    fingerprint = foundingBundleFingerprint(obj.digest)
  } catch {
    return MALFORMED
  }
  // Re-serialise in cadre-core's own mint key order, so the string equals the mint byte for byte.
  const invitationJson = JSON.stringify({
    v: 1,
    partyId: inv.partyId,
    invitePrivateKey: inv.invitePrivateKey,
    invite: {
      key: invite.key,
      peerId: invite.peerId,
      expiresAt: invite.expiresAt,
      totalUses: invite.totalUses,
      stampId: invite.stampId,
      issuerKey: invite.issuerKey,
      issuerSig: invite.issuerSig
    },
    ownerKeys: [...ownerKeys],
    members: [...members]
  })
  return {
    ok: true,
    fingerprint,
    code: {
      v: 2,
      invitation: CADRE_INVITATION_PREFIX_EXPECTED + bytesToBase64url(asciiToBytes(invitationJson)),
      networkHash: obj.networkHash,
      name: obj.name,
      genesis: {
        userId: g.userId as string,
        signerKey: g.signerKey as string,
        authorityId: g.authorityId as string,
        adminEffectiveAt: g.adminEffectiveAt as string
      },
      digest: obj.digest
    }
  }
}
