// pairing-statement.spec.ts — the pairing statement digests and verifiers: digest binding, X-vs-Y,
// curve dispatch, expiry semantics, the mint-time current-officer test and the purity scan.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  PAIRING_DIGEST_TAG,
  PAIRING_REMOVE_DIGEST_TAG,
  isCurrentPairingOfficer,
  pairingRemoveDigest,
  pairingStatementDigest,
  verifyPairingRemove,
  verifyPairingStatement,
  type VerifiablePairingStatement
} from '../src/pairing/pairing-statement.js'
import { bytesToBase64url, digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeDistinctTestUser,
  seedUserInvite,
  signTestDigest,
  type TestNetworkContext
} from './fixtures/test-context.js'

const NET = 'a'.repeat(64)
const PEER_A = '12D3KooWpeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PEER_B = '12D3KooWpeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function newNonce (): string { return bytesToBase64url(randomBytes(16)) }
function inMinutes (m: number): string { return toCanonicalDatetime(Date.now() + m * 60_000) }

interface Founder { net: TestNetworkContext, key: { privBytes: Uint8Array, pubHex: string } }

async function p256Founder (): Promise<Founder> {
  const key = makeP256TestKey()
  const net = await createTestNetwork({
    user: { activeKeys: [{ key: key.pubHex, type: 'P' as never, expiration: Date.now() + 86_400_000 }] }
  })
  return { net, key }
}

async function signStatement (f: Founder, fields: { userId?: string, nonce?: string, expiresAt?: string, requesterPeerId?: string, networkHash?: string }): Promise<{ statement: VerifiablePairingStatement, networkHash: string }> {
  const networkHash = fields.networkHash ?? NET
  const base = {
    userId: fields.userId ?? f.net.user.id,
    nonce: fields.nonce ?? newNonce(),
    expiresAt: fields.expiresAt ?? inMinutes(10),
    requesterPeerId: fields.requesterPeerId ?? PEER_A
  }
  const digest = await pairingStatementDigest(f.net.ctx.db, { networkHash, ...base })
  const sig = signDigestP256(bytesToBase64url(digest), f.key.privBytes)
  return { statement: { ...base, keyPub: f.key.pubHex, sig }, networkHash }
}

describe('pairing-statement', function () {
  this.timeout(30_000)

  describe('digests', () => {
    it('S-1 the two tags are the fixed protocol tokens', () => {
      expect(PAIRING_DIGEST_TAG).to.equal('vt-pairing')
      expect(PAIRING_REMOVE_DIGEST_TAG).to.equal('vt-pairing-remove')
    })

    it('S-2 the statement digest equals an independent Digest() run and binds every field', async () => {
      const { ctx } = await createTestNetwork()
      const nonce = newNonce()
      const expiresAt = inMinutes(10)
      const base = { networkHash: NET, userId: 'user-x', nonce, expiresAt, requesterPeerId: PEER_A }
      const got = await pairingStatementDigest(ctx.db, base)
      const ref = await ctx.db
        .prepare("select Digest('vt-pairing', :a, :b, :c, :d, :e) as d")
        .get({ a: NET, b: 'user-x', c: nonce, d: expiresAt, e: PEER_A })
      expect(Array.from(got)).to.deep.equal(Array.from(digestToBytes(ref!.d)))

      const hex = (b: Uint8Array): string => Array.from(b).join(',')
      const variants = [
        { ...base, networkHash: 'b'.repeat(64) },
        { ...base, userId: 'user-y' },
        { ...base, nonce: newNonce() },
        { ...base, expiresAt: inMinutes(11) },
        { ...base, requesterPeerId: PEER_B }
      ]
      for (const v of variants) expect(hex(await pairingStatementDigest(ctx.db, v))).to.not.equal(hex(got))

      const untagged = await ctx.db.prepare('select Digest(:a, :b, :c, :d, :e) as d').get({ a: NET, b: 'user-x', c: nonce, d: expiresAt, e: PEER_A })
      expect(hex(digestToBytes(untagged!.d))).to.not.equal(hex(got))
      const preBinding = await ctx.db.prepare("select Digest('vt-pairing', :a, :b, :c, :d) as d").get({ a: NET, b: 'user-x', c: nonce, d: expiresAt })
      expect(hex(digestToBytes(preBinding!.d))).to.not.equal(hex(got))

      const remove = await pairingRemoveDigest(ctx.db, { networkHash: NET, userId: 'user-x', nonce, peerId: PEER_A, expiresAt })
      expect(hex(remove)).to.not.equal(hex(got))
    })

    it('S-2b a statement signed for one requester peer fails when presented with another', async () => {
      const f = await p256Founder()
      const { statement, networkHash } = await signStatement(f, { requesterPeerId: PEER_A })
      const ok = await verifyPairingStatement(f.net.ctx.db, { networkHash, statement, nowCanonical: nowCanonicalDatetime(), checkExpiry: true })
      expect(ok).to.deep.equal({ ok: true })
      const swapped = await verifyPairingStatement(f.net.ctx.db, { networkHash, statement: { ...statement, requesterPeerId: PEER_B }, nowCanonical: nowCanonicalDatetime(), checkExpiry: true })
      expect(swapped).to.deep.equal({ ok: false, reason: 'bad-signature' })
    })
  })

  describe('verifyPairingStatement', () => {
    it('S-3 a P-256 officer statement verifies with and without the expiry check', async () => {
      const f = await p256Founder()
      const { statement, networkHash } = await signStatement(f, {})
      const now = nowCanonicalDatetime()
      expect(await verifyPairingStatement(f.net.ctx.db, { networkHash, statement, nowCanonical: now, checkExpiry: true })).to.deep.equal({ ok: true })
      expect(await verifyPairingStatement(f.net.ctx.db, { networkHash, statement, nowCanonical: now, checkExpiry: false })).to.deep.equal({ ok: true })
    })

    it('S-4 a secp256k1 officer statement verifies, so the curve dispatch reaches SignatureValid', async () => {
      const net = await createTestNetwork()
      const base = { userId: net.user.id, nonce: newNonce(), expiresAt: inMinutes(10), requesterPeerId: PEER_A }
      const digest = await pairingStatementDigest(net.ctx.db, { networkHash: NET, ...base })
      const signed = signTestDigest(net.user, bytesToBase64url(digest))
      const statement = { ...base, keyPub: signed.signerKey!, sig: signed.signature }
      expect(await verifyPairingStatement(net.ctx.db, { networkHash: NET, statement, nowCanonical: nowCanonicalDatetime(), checkExpiry: true })).to.deep.equal({ ok: true })
    })

    it('S-5 a cross-protocol, foreign-key, tampered or other-network signature is bad-signature', async () => {
      const f = await p256Founder()
      const db = f.net.ctx.db
      const now = nowCanonicalDatetime()
      const { statement, networkHash } = await signStatement(f, {})
      const bad = { ok: false, reason: 'bad-signature' }

      const removeDigest = await pairingRemoveDigest(db, { networkHash, userId: statement.userId, nonce: statement.nonce, peerId: PEER_A, expiresAt: statement.expiresAt })
      const removeSig = signDigestP256(bytesToBase64url(removeDigest), f.key.privBytes)
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, sig: removeSig }, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)

      const other = makeP256TestKey()
      const stmtDigest = await pairingStatementDigest(db, { networkHash, userId: statement.userId, nonce: statement.nonce, expiresAt: statement.expiresAt, requesterPeerId: PEER_A })
      const foreign = signDigestP256(bytesToBase64url(stmtDigest), other.privBytes)
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, sig: foreign }, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)

      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, nonce: newNonce() }, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)
      expect(await verifyPairingStatement(db, { networkHash: 'c'.repeat(64), statement, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)
    })

    it('S-6 a key that is not the officer\'s, or is expired, is key-not-current', async () => {
      const f = await p256Founder()
      const db = f.net.ctx.db
      const { statement, networkHash } = await signStatement(f, {})
      const stranger = makeP256TestKey()
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, keyPub: stranger.pubHex }, nowCanonical: nowCanonicalDatetime(), checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'key-not-current' })

      // The founder's key is past its Expiration at a later "now".
      const later = toCanonicalDatetime(Date.now() + 3 * 86_400_000)
      const farFuture = inMinutes(3 * 24 * 60 + 10)
      const late = await signStatement(f, { expiresAt: farFuture })
      expect(await verifyPairingStatement(db, { networkHash, statement: late.statement, nowCanonical: later, checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'key-not-current' })

      // A second key inserted already expired (early "now" at insert).
      const expired = makeP256TestKey()
      const expiredAt = toCanonicalDatetime(Date.now() - 86_400_000)
      const keyDigest = await db.prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
        .get({ userId: f.net.user.id, pubKey: expired.pubHex, type: 'P', expiration: expiredAt })
      await db.exec(
        `insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
         values (:userId, 'P', :pubKey, :expiration)`,
        {
          userId: f.net.user.id,
          pubKey: expired.pubHex,
          expiration: expiredAt,
          userKey: f.key.pubHex,
          signature: signDigestP256(keyDigest!.d as string, f.key.privBytes),
          now: toCanonicalDatetime(Date.now() - 2 * 86_400_000)
        }
      )
      const sig = signDigestP256(bytesToBase64url(await pairingStatementDigest(db, { networkHash, userId: statement.userId, nonce: statement.nonce, expiresAt: statement.expiresAt, requesterPeerId: PEER_A })), expired.privBytes)
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, keyPub: expired.pubHex, sig }, nowCanonical: nowCanonicalDatetime(), checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'key-not-current' })
    })

    it('S-7 a random user and a keyed non-officer are not-officer; X with Y\'s key is key-not-current', async () => {
      // The founder here keeps the default secp256k1 key: the invite fixture signs with it.
      const f: Founder = { net: await createTestNetwork(), key: makeP256TestKey() }
      const db = f.net.ctx.db
      const networkHash = NET
      const statement = { userId: f.net.user.id, nonce: newNonce(), expiresAt: inMinutes(10), requesterPeerId: PEER_A, keyPub: f.net.user.activeKeys[0]!.key, sig: 'ab'.repeat(32) }
      const now = nowCanonicalDatetime()
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, userId: 'nobody-here' }, nowCanonical: now, checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'not-officer' })

      // Y: a user with a key and no Officer row.
      const auth = await addTestAuthority(f.net)
      const y = makeDistinctTestUser()
      const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, y)
      await db.exec(
        `insert into User (Id, Name, ImageRef)
         with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${Date.now() + 7}
         values (:userId, :userName, null)`,
        { userId: y.id, userName: y.name, inviteSlotCid, inviteSignature }
      )
      const yKey = makeP256TestKey()
      await db.exec(
        `insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = null, Signature = null, Tid = ${Date.now() + 8}, now = :now, IsSignatureValid = true
         values (:userId, 'P', :pubKey, :expiration)`,
        { userId: y.id, pubKey: yKey.pubHex, expiration: inMinutes(60 * 24), now }
      )
      const yBase = { userId: y.id, nonce: newNonce(), expiresAt: inMinutes(10), requesterPeerId: PEER_A }
      const yDigest = await pairingStatementDigest(db, { networkHash, ...yBase })
      const ySig = signDigestP256(bytesToBase64url(yDigest), yKey.privBytes)
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...yBase, keyPub: yKey.pubHex, sig: ySig }, nowCanonical: now, checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'not-officer' })

      // X's userId, Y's key and Y's signature over X's statement.
      const xBase = { userId: f.net.user.id, nonce: newNonce(), expiresAt: inMinutes(10), requesterPeerId: PEER_A }
      const xDigest = await pairingStatementDigest(db, { networkHash, ...xBase })
      const xSigByY = signDigestP256(bytesToBase64url(xDigest), yKey.privBytes)
      expect(await verifyPairingStatement(db, { networkHash, statement: { ...xBase, keyPub: yKey.pubHex, sig: xSigByY }, nowCanonical: now, checkExpiry: true }))
        .to.deep.equal({ ok: false, reason: 'key-not-current' })
    })

    it('S-8 an aged statement is expired under checkExpiry and still ok without it', async () => {
      const f = await p256Founder()
      const { statement, networkHash } = await signStatement(f, { expiresAt: inMinutes(-5) })
      const now = nowCanonicalDatetime()
      expect(await verifyPairingStatement(f.net.ctx.db, { networkHash, statement, nowCanonical: now, checkExpiry: true })).to.deep.equal({ ok: false, reason: 'expired' })
      expect(await verifyPairingStatement(f.net.ctx.db, { networkHash, statement, nowCanonical: now, checkExpiry: false })).to.deep.equal({ ok: true })
    })

    it('S-9 malformed input is bad-signature and never throws', async () => {
      const f = await p256Founder()
      const db = f.net.ctx.db
      const { statement, networkHash } = await signStatement(f, {})
      const now = nowCanonicalDatetime()
      const bad = { ok: false, reason: 'bad-signature' }
      const cases: Array<Record<string, unknown>> = [
        { sig: 42 },
        { keyPub: 'z'.repeat(66) },
        { userId: 'u'.repeat(129) },
        { expiresAt: '2030-01-01 00:00:00' },
        { nonce: 'short' },
        { requesterPeerId: 'has-hyphen' },
        { sig: 'a'.repeat(513) }
      ]
      for (const c of cases) {
        expect(await verifyPairingStatement(db, { networkHash, statement: { ...statement, ...c } as never, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)
      }
      expect(await verifyPairingStatement(db, { networkHash, statement: null as never, nowCanonical: now, checkExpiry: true })).to.deep.equal(bad)
      expect(await verifyPairingStatement(db, { networkHash, statement, nowCanonical: 'yesterday', checkExpiry: true })).to.deep.equal(bad)
    })
  })

  describe('verifyPairingRemove', () => {
    async function signRemove (f: Founder, over: { peerId?: string, expiresAt?: string, tag?: 'remove' | 'statement' } = {}): Promise<{ request: { userId: string, nonce: string, peerId: string, expiresAt: string, keyPub: string, sig: string }, networkHash: string }> {
      const base = { userId: f.net.user.id, nonce: newNonce(), peerId: PEER_B, expiresAt: over.expiresAt ?? inMinutes(10) }
      const digest = over.tag === 'statement'
        ? await pairingStatementDigest(f.net.ctx.db, { networkHash: NET, userId: base.userId, nonce: base.nonce, expiresAt: base.expiresAt, requesterPeerId: base.peerId })
        : await pairingRemoveDigest(f.net.ctx.db, { networkHash: NET, ...base })
      const sig = signDigestP256(bytesToBase64url(digest), f.key.privBytes)
      return { request: { ...base, peerId: over.peerId ?? base.peerId, keyPub: f.key.pubHex, sig }, networkHash: NET }
    }

    it('S-10 a valid remove verifies; a statement signature, a changed peer or an expired remove does not', async () => {
      const f = await p256Founder()
      const db = f.net.ctx.db
      const now = nowCanonicalDatetime()
      const good = await signRemove(f)
      expect(await verifyPairingRemove(db, { ...good, nowCanonical: now })).to.deep.equal({ ok: true })

      const asStatement = await signRemove(f, { tag: 'statement' })
      expect(await verifyPairingRemove(db, { ...asStatement, nowCanonical: now })).to.deep.equal({ ok: false, reason: 'bad-signature' })

      const changed = await signRemove(f, { peerId: PEER_A })
      expect(await verifyPairingRemove(db, { ...changed, nowCanonical: now })).to.deep.equal({ ok: false, reason: 'bad-signature' })

      const old = await signRemove(f, { expiresAt: inMinutes(-5) })
      expect(await verifyPairingRemove(db, { ...old, nowCanonical: now })).to.deep.equal({ ok: false, reason: 'expired' })
    })
  })

  describe('isCurrentPairingOfficer', () => {
    it('S-12 the current officer passes; a stranger, a keyed non-officer and a pre-administration clock fail closed', async () => {
      const { ctx, user } = await createTestNetwork()
      const db = ctx.db
      expect(await isCurrentPairingOfficer(db, { userId: user.id, nowCanonical: nowCanonicalDatetime() })).to.equal(true)
      expect(await isCurrentPairingOfficer(db, { userId: 'nobody-here', nowCanonical: nowCanonicalDatetime() })).to.equal(false)

      const first = await db.prepare('select min(EffectiveAt) as e from Admin').get({})
      const before = toCanonicalDatetime(new Date(String(first!.e) + 'Z').getTime() - 86_400_000)
      expect(await isCurrentPairingOfficer(db, { userId: user.id, nowCanonical: before })).to.equal(false)
      expect(await isCurrentPairingOfficer(db, { userId: user.id, nowCanonical: 'not a time' })).to.equal(false)
      expect(await isCurrentPairingOfficer(db, { userId: 42 as never, nowCanonical: nowCanonicalDatetime() })).to.equal(false)
    })

    it('S-12b a user without an Officer row is not a current officer', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const y = makeDistinctTestUser()
      const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, y)
      await net.ctx.db.exec(
        `insert into User (Id, Name, ImageRef)
         with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${Date.now() + 9}
         values (:userId, :userName, null)`,
        { userId: y.id, userName: y.name, inviteSlotCid, inviteSignature }
      )
      expect(await isCurrentPairingOfficer(net.ctx.db, { userId: y.id, nowCanonical: nowCanonicalDatetime() })).to.equal(false)
    })
  })

  describe('source', () => {
    it('S-11 the module is browser-pure and uses no reserved bind names', () => {
      const file = join(dirname(fileURLToPath(import.meta.url)), '../src/pairing/pairing-statement.ts')
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      const imports = code.split('\n').filter(l => /^\s*import\b/.test(l))
      expect(imports).to.have.length(2)
      for (const l of imports) {
        expect(l).to.match(/from '@quereus\/quereus'|from '\.\.\/utils\.js'/)
      }
      expect(imports.filter(l => l.includes('@quereus/quereus')).every(l => /^\s*import type /.test(l))).to.equal(true)
      expect(code).to.not.match(/console\.|\bBuffer\b|node:|Date\.now|new Date/)
      expect(code).to.not.match(/:(limit|desc|group|order|type|key|or)\b/)
      expect(code).to.contain('SignatureValidP256')
      expect(code).to.contain('SignatureValid')
    })
  })
})
