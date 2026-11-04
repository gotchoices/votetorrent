/**
 * dashboard-pairing-revocation-schema.spec.ts — the DashboardPairingRevocation table (votetorrent.qsql) and
 * src/pairing/pairing-revocation.ts.
 *
 * Proves the write rule in both directions: an officer's own live key (P-256 or secp256k1) can revoke one
 * pairing, and every other write is refused, naming the CHECK that refused it (InsertValid, CantUpdate,
 * CantDelete). Attacks are driven through the RAW schema (`rawInsert`), not the module, so the schema is
 * what is under test. A nested describe then disables each CHECK in a fresh database and watches the
 * attack it guards against succeed, which proves every CHECK is load-bearing.
 */

import { expect } from 'chai'
import type { Database, SqlParameters } from '@quereus/quereus'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature, User, UserKeyType } from '@votetorrent/vote-core'
import { setSchemaSql } from '../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import {
  PAIRING_REVOKE_DIGEST_TAG,
  PairingRevocationError,
  isPairingRevoked,
  pairingRevokeDigest,
  revokeDashboardPairing,
  type PairingRevocationSigner
} from '../src/pairing/pairing-revocation.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey } from './fixtures/p256-signer.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  type TestAuthorityContext,
  type TestNetworkContext
} from './fixtures/test-context.js'

const DAY = 86_400_000

interface P256Key { privBytes: Uint8Array, pubHex: string }

interface Rig {
  net: TestNetworkContext
  /** the revoking officer: a second user in the network, whose only key is P-256 */
  userId: string
  key: P256Key
  /** the officer's P-256 signer */
  signer: PairingRevocationSigner
  /** the founding user (secp256k1 key) */
  other: { userId: string, signer: PairingRevocationSigner }
}

const freshNonce = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function p256Signer (userId: string, key: P256Key, counter?: { n: number }): PairingRevocationSigner {
  return {
    userId,
    signingPublicKey: key.pubHex,
    sign: async (digest: Uint8Array): Promise<Signature> => {
      if (counter !== undefined) counter.n += 1
      return { signerUserId: userId, signerKey: key.pubHex, signature: bytesToHex(p256.sign(digest, key.privBytes)) }
    }
  }
}

/** Insert a second user with a first key (copy of threshold-authority.ts `insertFixtureUser`). */
async function insertFixtureUser (auth: TestAuthorityContext, user: User): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
  const key = user.activeKeys[0]!
  await auth.ctx.db.exec(
    `insert into UserKey (UserId, Type, PubKey, Expiration)
     with context UserKey = null, Signature = null, Tid = ${tid + 1}, now = :now, IsSignatureValid = true
     values (:userId, :type, :pubKey, :expiration)`,
    {
      userId: user.id,
      type: key.type,
      pubKey: key.key,
      expiration: toCanonicalDatetime(key.expiration),
      now: nowCanonicalDatetime()
    }
  )
}

async function makeRig (): Promise<Rig> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const key = makeP256TestKey()
  const user = makeDistinctTestUser()
  user.activeKeys = [{ key: key.pubHex, type: 'P' as UserKeyType, expiration: Date.now() + DAY }]
  await insertFixtureUser(auth, user)
  return {
    net,
    userId: user.id,
    key,
    signer: p256Signer(user.id, key),
    other: {
      userId: net.user.id,
      signer: { userId: net.user.id, signingPublicKey: net.user.activeKeys[0]!.key, sign: makeTestSignCallback(net.user) }
    }
  }
}

interface RawInsert { userId: string, nonce: string, userKey: string | null, signature: string | null, now?: string }

/** The same SQL the module issues, with every context value under the caller's control. */
function rawInsert (db: Database, a: RawInsert): Promise<unknown> {
  const ctx = ['UserKey = :userKey', 'Signature = :signature']
  const params: SqlParameters = { userId: a.userId, nonce: a.nonce, userKey: a.userKey, signature: a.signature }
  if (a.now !== undefined) {
    ctx.push('now = :now')
    params.now = a.now
  }
  return db.exec(
    `insert into DashboardPairingRevocation (UserId, Nonce) with context ${ctx.join(', ')} values (:userId, :nonce)`,
    params
  )
}

async function expectRefused (p: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown
  try { await p } catch (err) { caught = err }
  expect(caught, `expected a refusal naming ${constraint}`).to.be.instanceOf(Error)
  expect((caught as Error).message).to.include(constraint)
}

/** Sign Digest(tag, userId, nonce) with the rig's P-256 key. */
async function signA (rig: Rig, nonce: string): Promise<string> {
  const digest = await pairingRevokeDigest(rig.net.ctx.db, { userId: rig.userId, nonce })
  return bytesToHex(p256.sign(digest, rig.key.privBytes))
}

// The attacks, each as a function that RUNS the raw insert (so the mutation controls can replay the same one).
const attacks = {
  async unsigned (rig: Rig, nonce: string): Promise<unknown> {
    return rawInsert(rig.net.ctx.db, { userId: rig.userId, nonce, userKey: null, signature: null, now: nowCanonicalDatetime() })
  },
  async expiredKey (rig: Rig, nonce: string): Promise<unknown> {
    return rawInsert(rig.net.ctx.db, {
      userId: rig.userId,
      nonce,
      userKey: rig.key.pubHex,
      signature: await signA(rig, nonce),
      now: toCanonicalDatetime(Date.now() + 2 * DAY)
    })
  },
  async otherUsersKey (rig: Rig, nonce: string): Promise<unknown> {
    const other = rig.other
    const digest = await pairingRevokeDigest(rig.net.ctx.db, { userId: rig.userId, nonce })
    const sig = await other.signer.sign(digest)
    return rawInsert(rig.net.ctx.db, {
      userId: rig.userId,
      nonce,
      userKey: other.signer.signingPublicKey,
      signature: sig.signature,
      now: nowCanonicalDatetime()
    })
  }
}

const revoked = (rig: Rig, nonce: string): Promise<boolean> =>
  isPairingRevoked(rig.net.ctx.db, { userId: rig.userId, nonce })

describe('DashboardPairingRevocation schema and pairing-revocation module', function () {
  this.timeout(180_000)

  let rig: Rig

  before(async () => {
    rig = await makeRig()
  })

  it('T1 accepts a revocation signed by one of the officer\'s own P-256 keys', async () => {
    const nonce = freshNonce()
    await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: rig.signer })
    expect(await revoked(rig, nonce)).to.equal(true)
  })

  it('T2 accepts a revocation signed by a secp256k1 key of the user', async () => {
    // the default test user registers a secp256k1 key
    const plain = await createTestNetwork()
    const plainSigner: PairingRevocationSigner = {
      userId: plain.user.id,
      signingPublicKey: plain.user.activeKeys[0]!.key,
      sign: makeTestSignCallback(plain.user)
    }
    const nonce = freshNonce()
    await revokeDashboardPairing(plain.ctx, { userId: plain.user.id, nonce, signer: plainSigner })
    expect(await isPairingRevoked(plain.ctx.db, { userId: plain.user.id, nonce })).to.equal(true)
  })

  it('T3 refuses a revocation signed by another user\'s key', async () => {
    const nonce = freshNonce()
    await expectRefused(attacks.otherUsersKey(rig, nonce), 'InsertValid')
    expect(await revoked(rig, nonce)).to.equal(false)
  })

  it('T4 refuses a revocation whose signer key has expired', async () => {
    const nonce = freshNonce()
    await expectRefused(attacks.expiredKey(rig, nonce), 'InsertValid')
    expect(await revoked(rig, nonce)).to.equal(false)
    // control: the same key with the real clock is accepted
    const ok = freshNonce()
    await rawInsert(rig.net.ctx.db, {
      userId: rig.userId, nonce: ok, userKey: rig.key.pubHex, signature: await signA(rig, ok), now: nowCanonicalDatetime()
    })
    expect(await revoked(rig, ok)).to.equal(true)
  })

  it('T5 refuses a bad signature', async () => {
    const nonce = freshNonce()
    await expectRefused(
      rawInsert(rig.net.ctx.db, {
        userId: rig.userId, nonce, userKey: rig.key.pubHex, signature: await signA(rig, freshNonce()), now: nowCanonicalDatetime()
      }),
      'InsertValid'
    )
    expect(await revoked(rig, nonce)).to.equal(false)
  })

  it('T6 refuses a wrong-curve signature', async () => {
    const nonce = freshNonce()
    const digest = await pairingRevokeDigest(rig.net.ctx.db, { userId: rig.userId, nonce })
    const wrongCurve = bytesToHex(secp256k1.sign(digest, rig.key.privBytes))
    await expectRefused(
      rawInsert(rig.net.ctx.db, {
        userId: rig.userId, nonce, userKey: rig.key.pubHex, signature: wrongCurve, now: nowCanonicalDatetime()
      }),
      'InsertValid'
    )
    expect(await revoked(rig, nonce)).to.equal(false)
  })

  it('T7 refuses an unsigned insert and an insert with no now bound', async () => {
    const unsigned = freshNonce()
    await expectRefused(attacks.unsigned(rig, unsigned), 'InsertValid')
    expect(await revoked(rig, unsigned)).to.equal(false)

    const noNow = freshNonce()
    // An omitted context value is refused by the engine before any CHECK runs (it names the table's context).
    await expectRefused(
      rawInsert(rig.net.ctx.db, { userId: rig.userId, nonce: noNow, userKey: rig.key.pubHex, signature: await signA(rig, noNow) }),
      'DashboardPairingRevocation'
    )
    expect(await revoked(rig, noNow)).to.equal(false)

    // A null now: the leg `Expiration > context.now` is NULL, and InsertValid must still refuse (no NULL bypass).
    const nullNow = freshNonce()
    await expectRefused(
      rig.net.ctx.db.exec(
        'insert into DashboardPairingRevocation (UserId, Nonce) with context UserKey = :userKey, Signature = :signature, now = null values (:userId, :nonce)',
        { userKey: rig.key.pubHex, signature: await signA(rig, nullNow), userId: rig.userId, nonce: nullNow }
      ),
      'InsertValid'
    )
    expect(await revoked(rig, nullNow)).to.equal(false)
  })

  it('T8 refuses update and delete of a committed revocation', async () => {
    const nonce = freshNonce()
    await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: rig.signer })
    const db = rig.net.ctx.db
    const ctxParams = { userKey: rig.key.pubHex, signature: await signA(rig, nonce), now: nowCanonicalDatetime() }
    await expectRefused(
      db.exec(
        'update DashboardPairingRevocation with context UserKey = :userKey, Signature = :signature, now = :now set Nonce = :other where UserId = :userId and Nonce = :nonce',
        { ...ctxParams, other: freshNonce(), userId: rig.userId, nonce }
      ),
      'CantUpdate'
    )
    await expectRefused(
      db.exec(
        'delete from DashboardPairingRevocation with context UserKey = :userKey, Signature = :signature, now = :now where UserId = :userId and Nonce = :nonce',
        { ...ctxParams, userId: rig.userId, nonce }
      ),
      'CantDelete'
    )
    expect(await revoked(rig, nonce)).to.equal(true)
  })

  it('T9 isPairingRevoked is true only for the exact (UserId, Nonce)', async () => {
    const nonce = freshNonce()
    await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: rig.signer })
    const db = rig.net.ctx.db
    expect(await isPairingRevoked(db, { userId: rig.userId, nonce })).to.equal(true)
    expect(await isPairingRevoked(db, { userId: rig.userId, nonce: freshNonce() })).to.equal(false)
    expect(await isPairingRevoked(db, { userId: rig.other.userId, nonce })).to.equal(false)
  })

  it('T10 pairingRevokeDigest equals the schema pre-image and the schema names the tag in both curve branches', async () => {
    const nonce = freshNonce()
    const db = rig.net.ctx.db
    const bytes = await pairingRevokeDigest(db, { userId: rig.userId, nonce })
    const row = await db
      .prepare("select Digest('vt-pairing-revoke', :userId, :nonce) as d")
      .get({ userId: rig.userId, nonce })
    expect(bytesToHex(bytes)).to.equal(bytesToHex(digestToBytes(row!.d)))
    const needle = `Digest('${PAIRING_REVOKE_DIGEST_TAG}', new.UserId, new.Nonce)`
    expect(VOTETORRENT_SCHEMA_SQL.split(needle).length - 1).to.equal(2)
  })

  it('T11 revokeDashboardPairing is idempotent and never re-signs', async () => {
    const counter = { n: 0 }
    const signer = p256Signer(rig.userId, rig.key, counter)
    const nonce = freshNonce()
    await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer })
    await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer })
    expect(counter.n).to.equal(1)
    expect(await revoked(rig, nonce)).to.equal(true)
  })

  it('T12 revokeDashboardPairing refuses before signing', async () => {
    const counter = { n: 0 }
    const nonce = freshNonce()

    const wrongUser = p256Signer(rig.other.userId, rig.key, counter)
    const e1 = await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: wrongUser }).then(() => undefined, (e: unknown) => e)
    expect(e1).to.be.instanceOf(PairingRevocationError)
    expect((e1 as PairingRevocationError).reason).to.equal('signer-mismatch')

    const strangerKey = makeP256TestKey()
    const stranger = p256Signer(rig.userId, strangerKey, counter)
    const e2 = await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: stranger }).then(() => undefined, (e: unknown) => e)
    expect(e2).to.be.instanceOf(PairingRevocationError)
    expect((e2 as PairingRevocationError).reason).to.equal('key-not-current')

    expect(counter.n).to.equal(0)
    for (const e of [e1, e2]) {
      const m = (e as Error).message
      expect(m).to.not.include('InsertValid')
      expect(m).to.not.include('select')
    }
    expect(await revoked(rig, nonce)).to.equal(false)
  })

  it('T13 a schema refusal surfaces as PairingRevocationError refused', async () => {
    const nonce = freshNonce()
    // Claims the right signer key but signs the digest of a different nonce.
    const liar: PairingRevocationSigner = {
      userId: rig.userId,
      signingPublicKey: rig.key.pubHex,
      sign: async (): Promise<Signature> => ({
        signerUserId: rig.userId,
        signerKey: rig.key.pubHex,
        signature: await signA(rig, freshNonce())
      })
    }
    const err = await revokeDashboardPairing(rig.net.ctx, { userId: rig.userId, nonce, signer: liar }).then(() => undefined, (e: unknown) => e)
    expect(err).to.be.instanceOf(PairingRevocationError)
    expect((err as PairingRevocationError).reason).to.equal('refused')
    expect((err as Error).message).to.equal('pairing revocation: the schema refused the revocation')
    expect(await revoked(rig, nonce)).to.equal(false)
  })

  describe('each CHECK is load-bearing', () => {
    const BLOCK_START = 'table DashboardPairingRevocation ('
    const BLOCK_END = 'with context ( UserKey text null'

    /** Replace `needle` EXACTLY ONCE inside the new table's block. */
    function disableInTable (sql: string, needle: string, replacement: string): string {
      const start = sql.indexOf(BLOCK_START)
      expect(start, 'table block present').to.be.greaterThan(-1)
      const end = sql.indexOf(BLOCK_END, start)
      expect(end, 'table block end present').to.be.greaterThan(start)
      const block = sql.slice(start, end)
      const count = block.split(needle).length - 1
      if (count !== 1) throw new Error(`disableInTable: needle occurs ${count} times in the block: ${needle}`)
      return sql.slice(0, start) + block.replace(needle, replacement) + sql.slice(end)
    }

    /** Index of the `)` matching the `(` at `open`, ignoring parentheses inside '...' literals. */
    function matchingParen (sql: string, open: number): number {
      let depth = 0
      let inString = false
      for (let i = open; i < sql.length; i++) {
        const ch = sql[i]
        if (inString) {
          if (ch === "'") inString = false
          continue
        }
        if (ch === "'") inString = true
        else if (ch === '(') depth += 1
        else if (ch === ')') {
          depth -= 1
          if (depth === 0) return i
        }
      }
      throw new Error('disableCheck: unbalanced parentheses')
    }

    /** Replace the body of `constraint <name> check [on verb]` in the new table's block with `(true)`. */
    function disableCheck (sql: string, name: string): string {
      const start = sql.indexOf(BLOCK_START)
      const end = sql.indexOf(BLOCK_END, start)
      const block = sql.slice(start, end)
      const m = new RegExp(`constraint ${name} check(?: on (?:insert|update|delete))?\\s*`).exec(block)
      if (m === null) throw new Error(`disableCheck: no constraint ${name} in the block`)
      const open = block.indexOf('(', m.index + m[0].length - 1)
      const close = matchingParen(block, open)
      const mutatedBlock = block.slice(0, open) + '(true)' + block.slice(close + 1)
      return sql.slice(0, start) + mutatedBlock + sql.slice(end)
    }

    /** Run `body` against a FRESH network built on the mutated schema; the override is always reset. */
    async function withMutation (mutated: string, body: (r: Rig) => Promise<void>): Promise<void> {
      expect(mutated).to.not.equal(VOTETORRENT_SCHEMA_SQL)
      setSchemaSql(mutated)
      try {
        const r = await makeRig()
        await body(r)
      } finally {
        setSchemaSql(undefined)
      }
    }

    it('M1 disabling InsertValid lets the unsigned insert through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'InsertValid'), async (r) => {
        const nonce = freshNonce()
        await attacks.unsigned(r, nonce)
        expect(await revoked(r, nonce)).to.equal(true)
      })
    })

    it('M2 disabling CantUpdate lets the update through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CantUpdate'), async (r) => {
        const nonce = freshNonce()
        await revokeDashboardPairing(r.net.ctx, { userId: r.userId, nonce, signer: r.signer })
        const other = freshNonce()
        await r.net.ctx.db.exec(
          'update DashboardPairingRevocation with context UserKey = :userKey, Signature = :signature, now = :now set Nonce = :other where UserId = :userId and Nonce = :nonce',
          { userKey: r.key.pubHex, signature: await signA(r, nonce), now: nowCanonicalDatetime(), other, userId: r.userId, nonce }
        )
        expect(await revoked(r, other)).to.equal(true)
        expect(await revoked(r, nonce)).to.equal(false)
      })
    })

    it('M3 disabling CantDelete lets the delete through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CantDelete'), async (r) => {
        const nonce = freshNonce()
        await revokeDashboardPairing(r.net.ctx, { userId: r.userId, nonce, signer: r.signer })
        await r.net.ctx.db.exec(
          'delete from DashboardPairingRevocation with context UserKey = :userKey, Signature = :signature, now = :now where UserId = :userId and Nonce = :nonce',
          { userKey: r.key.pubHex, signature: await signA(r, nonce), now: nowCanonicalDatetime(), userId: r.userId, nonce }
        )
        expect(await revoked(r, nonce)).to.equal(false)
      })
    })

    it('M4 removing the expiration leg lets the expired-key insert through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, ' and K.Expiration > context.now', '')
      await withMutation(mutated, async (r) => {
        const nonce = freshNonce()
        await attacks.expiredKey(r, nonce)
        expect(await revoked(r, nonce)).to.equal(true)
      })
    })

    it('M5 removing the same-user leg lets another user\'s key through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, 'K.UserId = new.UserId and ', '')
      await withMutation(mutated, async (r) => {
        const nonce = freshNonce()
        await attacks.otherUsersKey(r, nonce)
        expect(await revoked(r, nonce)).to.equal(true)
      })
    })
  })
})
