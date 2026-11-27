// pool-envelope.ts — end-to-end sealed messages between pool members (spike 102).
//
// Every pool message travels through the authority's rendezvous node, which stores it until the
// recipient polls (voters only ever dial OUT, so no voter needs to be reachable). The rendezvous
// must not be able to read what it carries: a `merge` hands over vote ciphertexts next to the voter
// entries that name their owners, and anyone who logged that pairing could read every vote by name
// once the election key is released. So each message is sealed to its recipient:
//
//   * The recipient's key is derived from its libp2p peer id, which IS its Ed25519 public key
//     (identity multihash), so the rendezvous cannot substitute a key of its own for a peer id it
//     relays. Ed25519 -> X25519 by the standard birational map.
//   * Seal: ephemeral X25519, HKDF-SHA256, XChaCha20-Poly1305; the AAD names the recipient.
//   * The sender signs the message INSIDE the seal with its own peer key, so the recipient knows
//     who wrote it and the rendezvous cannot forge one (it can still drop or delay messages — a
//     rendezvous can always deny service).
//
// Pure and Hermes-safe: @noble only, no Buffer, no TextDecoder, no libp2p import.

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { fromBase64url, toBase64url } from './pool-codec.js'
import { decodeUtf8Fatal } from '../key-release/election-block.js'

const ENVELOPE_LABEL = 'vt-pool-envelope-v1'
const SIGN_LABEL = 'vt-pool-message-v1'
const REQUEST_LABEL = 'vt-pool-request-v1'
/** A signed rendezvous request older (or newer) than this is refused. */
export const POOL_REQUEST_MAX_SKEW_MS = 2 * 60_000
/** A sealed message older (or newer) than this is refused, so a replayed envelope expires. */
export const POOL_ENVELOPE_MAX_SKEW_MS = 10 * 60_000

export interface SealedPoolEnvelope {
  v: 1
  /** recipient peer id */
  to: string
  /** base64url ephemeral X25519 public key */
  eph: string
  /** base64url 24-byte nonce */
  nonce: string
  /** base64url ciphertext */
  ct: string
}

export interface OpenedPoolEnvelope<T = unknown> {
  from: string
  sentAt: number
  body: T
}

export class PoolEnvelopeError extends Error {
  constructor (readonly code: 'bad-peer-id' | 'not-for-me' | 'malformed' | 'auth-failed' | 'bad-signature' | 'stale', message: string) {
    super(message)
    this.name = 'PoolEnvelopeError'
  }
}

// ---------------------------------------------------------------------------------------------
// peer id <-> Ed25519 public key (identity multihash, base58btc, libp2p's "12D3KooW…" form)
// ---------------------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]))
// varint 0x00 (identity) + length 36 + protobuf PublicKey { Type: Ed25519 (1), Data: 32 bytes }
const ED25519_PEER_ID_PREFIX = new Uint8Array([0x00, 0x24, 0x08, 0x01, 0x12, 0x20])

function base58Decode (text: string): Uint8Array | null {
  let bytes: number[] = []
  for (const ch of text) {
    const value = B58_INDEX.get(ch)
    if (value === undefined) return null
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (const ch of text) { if (ch === '1') bytes.push(0); else break }
  bytes = bytes.reverse()
  return new Uint8Array(bytes)
}

function base58Encode (bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = ''
  for (const byte of bytes) { if (byte === 0) out += '1'; else break }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!]
  return out
}

/** The Ed25519 public key inside a libp2p peer id, or a `bad-peer-id` error (only Ed25519 peers can pool). */
export function ed25519PublicKeyFromPeerId (peerId: string): Uint8Array {
  const bytes = typeof peerId === 'string' ? base58Decode(peerId) : null
  if (bytes === null || bytes.length !== ED25519_PEER_ID_PREFIX.length + 32 ||
    !ED25519_PEER_ID_PREFIX.every((b, i) => bytes[i] === b)) {
    throw new PoolEnvelopeError('bad-peer-id', 'pool envelope: the peer id is not an Ed25519 libp2p peer id')
  }
  return bytes.slice(ED25519_PEER_ID_PREFIX.length)
}

/** The libp2p peer id of an Ed25519 public key (inverse of {@link ed25519PublicKeyFromPeerId}). */
export function peerIdFromEd25519PublicKey (publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new PoolEnvelopeError('bad-peer-id', 'pool envelope: an Ed25519 public key is 32 bytes')
  return base58Encode(concatBytes(ED25519_PEER_ID_PREFIX, publicKey))
}

// ---------------------------------------------------------------------------------------------
// The sender's identity
// ---------------------------------------------------------------------------------------------

/** What a pool member needs to seal and open: its peer id and the 32-byte Ed25519 seed behind it. */
export interface PoolIdentity {
  peerId: string
  /** 32-byte Ed25519 secret seed (libp2p's 64-byte `raw` private key is seed || public key) */
  secretKey: Uint8Array
}

/**
 * A fresh pool identity for ONE pooling run. Pool identities are throwaway on purpose: they are
 * not the node's libp2p peer id, so the voters a phone pools with never learn its network
 * identity or address (spike 100 F2), and two pools running at once on one phone (one per
 * ballot) each get their own mailbox.
 */
export function createPoolIdentity (): PoolIdentity {
  return poolIdentityFromRawKey(ed25519.utils.randomSecretKey())
}

/** Build a {@link PoolIdentity} from a libp2p Ed25519 private key's `raw` bytes (64 = seed || pub, or a bare 32-byte seed). */
export function poolIdentityFromRawKey (raw: Uint8Array): PoolIdentity {
  if (!(raw instanceof Uint8Array) || (raw.length !== 64 && raw.length !== 32)) {
    throw new PoolEnvelopeError('bad-peer-id', 'pool identity: expected a 32- or 64-byte Ed25519 private key')
  }
  const secretKey = raw.slice(0, 32)
  return { peerId: peerIdFromEd25519PublicKey(ed25519.getPublicKey(secretKey)), secretKey }
}

// ---------------------------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------------------------

function envelopeKey (shared: Uint8Array, eph: Uint8Array, recipientX: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(eph, recipientX), utf8ToBytes(ENVELOPE_LABEL), 32)
}

function signedBytes (from: string, to: string, sentAt: number, bodyJson: string): Uint8Array {
  return sha256(utf8ToBytes(JSON.stringify([SIGN_LABEL, from, to, sentAt, bodyJson])))
}

/** Seal `body` (any JSON value) from `sender` to `recipientPeerId`. */
export function sealPoolEnvelope (sender: PoolIdentity, recipientPeerId: string, body: unknown, now: number = Date.now()): SealedPoolEnvelope {
  const recipientX = ed25519.utils.toMontgomery(ed25519PublicKeyFromPeerId(recipientPeerId))
  const ephSecret = x25519.utils.randomSecretKey()
  const eph = x25519.getPublicKey(ephSecret)
  const key = envelopeKey(x25519.getSharedSecret(ephSecret, recipientX), eph, recipientX)
  const bodyJson = JSON.stringify(body)
  const signature = ed25519.sign(signedBytes(sender.peerId, recipientPeerId, now, bodyJson), sender.secretKey)
  const plaintext = utf8ToBytes(JSON.stringify({ from: sender.peerId, sentAt: now, body: bodyJson, sig: toBase64url(signature) }))
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(`${ENVELOPE_LABEL}|${recipientPeerId}`)).encrypt(plaintext)
  key.fill(0)
  ephSecret.fill(0)
  return { v: 1, to: recipientPeerId, eph: toBase64url(eph), nonce: toBase64url(nonce), ct: toBase64url(ct) }
}

/** Open an envelope sealed to `me`. Throws {@link PoolEnvelopeError}; never returns an unauthenticated body. */
export function openPoolEnvelope<T = unknown> (me: PoolIdentity, envelope: unknown, now: number = Date.now()): OpenedPoolEnvelope<T> {
  const e = envelope as Partial<SealedPoolEnvelope> | null
  if (e === null || typeof e !== 'object' || e.v !== 1 || typeof e.to !== 'string') throw new PoolEnvelopeError('malformed', 'pool envelope: not a v1 envelope')
  if (e.to !== me.peerId) throw new PoolEnvelopeError('not-for-me', 'pool envelope: addressed to another peer')
  const eph = fromBase64url(e.eph)
  const nonce = fromBase64url(e.nonce)
  const ct = fromBase64url(e.ct)
  if (eph === null || eph.length !== 32 || nonce === null || nonce.length !== 24 || ct === null) {
    throw new PoolEnvelopeError('malformed', 'pool envelope: bad field encoding')
  }
  const mySecretX = ed25519.utils.toMontgomerySecret(me.secretKey)
  const myX = x25519.getPublicKey(mySecretX)
  let plaintext: Uint8Array
  try {
    const key = envelopeKey(x25519.getSharedSecret(mySecretX, eph), eph, myX)
    plaintext = xchacha20poly1305(key, nonce, utf8ToBytes(`${ENVELOPE_LABEL}|${me.peerId}`)).decrypt(ct)
    key.fill(0)
  } catch {
    throw new PoolEnvelopeError('auth-failed', 'pool envelope: could not be opened')
  } finally {
    mySecretX.fill(0)
  }
  let inner: { from?: unknown, sentAt?: unknown, body?: unknown, sig?: unknown }
  try {
    inner = JSON.parse(decodeUtf8Fatal(plaintext))
  } catch {
    throw new PoolEnvelopeError('malformed', 'pool envelope: inner message is not JSON')
  }
  if (typeof inner.from !== 'string' || typeof inner.sentAt !== 'number' || typeof inner.body !== 'string' || typeof inner.sig !== 'string') {
    throw new PoolEnvelopeError('malformed', 'pool envelope: inner message has the wrong shape')
  }
  const sig = fromBase64url(inner.sig)
  const senderKey = ed25519PublicKeyFromPeerId(inner.from)
  if (sig === null || !ed25519.verify(sig, signedBytes(inner.from, me.peerId, inner.sentAt, inner.body), senderKey)) {
    throw new PoolEnvelopeError('bad-signature', 'pool envelope: the sender signature does not verify')
  }
  if (Math.abs(now - inner.sentAt) > POOL_ENVELOPE_MAX_SKEW_MS) throw new PoolEnvelopeError('stale', 'pool envelope: too old or too far in the future')
  let body: T
  try {
    body = JSON.parse(inner.body) as T
  } catch {
    throw new PoolEnvelopeError('malformed', 'pool envelope: body is not JSON')
  }
  return { from: inner.from, sentAt: inner.sentAt, body }
}

// ---------------------------------------------------------------------------------------------
// Signed rendezvous requests: the rendezvous keys tables and mailboxes by POOL identity, so a
// request proves it holds that identity's key (the transport's peer id says nothing about it).
// ---------------------------------------------------------------------------------------------

function requestBytes (fields: readonly unknown[]): Uint8Array {
  return sha256(utf8ToBytes(JSON.stringify([REQUEST_LABEL, ...fields])))
}

/** Sign the fields of a rendezvous request with a pool identity (base64url Ed25519 signature). */
export function signPoolRequest (identity: PoolIdentity, fields: readonly unknown[]): string {
  return toBase64url(ed25519.sign(requestBytes(fields), identity.secretKey))
}

/** True when `sig` is `peerId`'s signature over `fields`. Never throws. */
export function verifyPoolRequest (peerId: string, fields: readonly unknown[], sig: unknown): boolean {
  try {
    const bytes = fromBase64url(sig)
    return bytes !== null && ed25519.verify(bytes, requestBytes(fields), ed25519PublicKeyFromPeerId(peerId))
  } catch {
    return false
  }
}
