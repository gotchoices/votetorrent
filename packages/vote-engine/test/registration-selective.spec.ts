/**
 * registration-selective.spec.ts — Phase 42-08 real-engine spec for the
 * selective-disclosure tier: `RegistrantSelective` creation inside the
 * Register flow (flat salted-leaf set commitment, D-11/D-12/D-13) and
 * `getDisclosedSelective` (per-field reveal filtered by
 * `ElectionDisclosurePolicy`, verified via the crypto plugin's `setVerify`,
 * D-14). This is the LAST plan of Phase 42 (CRUD-first, selective-
 * disclosure-last per the phase's own CONTEXT mandate).
 *
 * Covers (per 42-08-PLAN.md):
 *   - commit-with-payload: exactly one RegistrantSelective row,
 *     Registrant.SelectiveCid = the row's Cid, CidValid/RegistrantCidMatch pass.
 *   - null/empty payload: NO row, SelectiveCid stays NULL (Pitfall 3 — set_commit
 *     is never invoked on an absent/empty selective payload).
 *   - salt entropy: engine-generated salts are distinct and decode to >=16 bytes.
 *   - duplicate-name payload rejects BEFORE the DB ceremony (no partial rows).
 *   - the crypto plugin's empty-salt guard (the same primitive
 *     computeRegistrantSelectiveCid/set_commit relies on) rejects an
 *     empty-salt leaf.
 *   - getDisclosedSelective: audience-filtered reveal via a seeded
 *     ElectionDisclosurePolicy, opaque hidden digests, null when no row exists.
 *   - the returned {disclosed,hidden} subset round-trips through setVerify
 *     (genuine true / a flipped disclosed value false).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { fromString as uint8ArrayFromString } from 'uint8arrays'
import { setVerify } from '@optimystic/quereus-plugin-crypto'
import type { Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRegistrantSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

async function setupSelectiveTest (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
  electionId: string
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
  const sign = makeRegistrantSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign, electionId }
}

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `selective-registrant-${Date.now()}-${registrantSeq}`
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

// ===========================================================================
// selective disclosure
// ===========================================================================

describe('selective disclosure', () => {
  it('a Register with a selective payload creates exactly one RegistrantSelective row, Cid-linked to Registrant.SelectiveCid', async () => {
    const { auth, engine, sign } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] },
        selective: {
          expiration: FUTURE_EXPIRATION,
          details: [
            { name: 'income', value: 55000 },
            { name: 'dob', value: '1990-01-01' }
          ]
        }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'registrant must exist').to.not.be.undefined
    expect(registrant!.selectiveCid, 'Registrant.SelectiveCid must be set').to.be.a('string')

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const countRow = await ctx.db
      .prepare('select count(*) as n from RegistrantSelective where RegistrantId = :registrantId')
      .get({ registrantId })
    expect(Number(countRow?.n), 'exactly one RegistrantSelective row').to.equal(1)

    const selective = await engine.getRegistrantSelective(registrantId)
    expect(selective, 'RegistrantSelective row must be readable').to.not.be.undefined
    expect(selective!.cid).to.equal(registrant!.selectiveCid)
    expect(selective!.selectiveDetails).to.have.length(2)
  })

  it('a Register with NO selective payload creates no RegistrantSelective row and leaves SelectiveCid NULL', async () => {
    const { auth, engine, sign } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant!.selectiveCid, 'SelectiveCid must stay undefined/NULL').to.be.undefined

    const selective = await engine.getRegistrantSelective(registrantId)
    expect(selective, 'no RegistrantSelective row').to.be.undefined
  })

  it('a Register with an EMPTY selective.details list behaves identically to no selective payload (Pitfall 3)', async () => {
    const { auth, engine, sign } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] },
        selective: { expiration: FUTURE_EXPIRATION, details: [] }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant!.selectiveCid, 'SelectiveCid must stay undefined/NULL for an empty details list').to.be.undefined
    const selective = await engine.getRegistrantSelective(registrantId)
    expect(selective, 'no RegistrantSelective row for an empty details list').to.be.undefined
  })

  it('generates a distinct >=16-byte salt per leaf via the SQL random_bytes UDF', async () => {
    const { auth, engine, sign } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] },
        selective: {
          expiration: FUTURE_EXPIRATION,
          details: [
            { name: 'a', value: 1 },
            { name: 'b', value: 2 },
            { name: 'c', value: 3 }
          ]
        }
      },
      sign
    )

    const selective = await engine.getRegistrantSelective(registrantId)
    const leaves = selective!.selectiveDetails!
    expect(leaves).to.have.length(3)

    const salts = leaves.map((l) => l.salt)
    expect(new Set(salts).size, 'all salts must be distinct').to.equal(salts.length)
    for (const salt of salts) {
      const bytes = uint8ArrayFromString(salt, 'base64url')
      expect(bytes.length, `salt '${salt}' must decode to >=16 bytes (>=128 bits)`).to.be.at.least(16)
    }
  })

  it('rejects a payload with two leaves sharing a name BEFORE the DB ceremony runs (no partial rows)', async () => {
    const { auth, engine, sign } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    let threw = false
    try {
      await engine.register(
        {
          registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] },
          selective: {
            expiration: FUTURE_EXPIRATION,
            details: [
              { name: 'dup', value: 1 },
              { name: 'dup', value: 2 }
            ]
          }
        },
        sign
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected a duplicate leaf name to be rejected').to.be.true

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'no partial Registrant row after a duplicate-name rejection').to.be.undefined
    const selective = await engine.getRegistrantSelective(registrantId)
    expect(selective, 'no partial RegistrantSelective row after a duplicate-name rejection').to.be.undefined
  })

  it('the crypto plugin rejects an empty-salt leaf — the same primitive computeRegistrantSelectiveCid/set_commit relies on (D-13)', async () => {
    const { engine } = await setupSelectiveTest()
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    let threw = false
    try {
      await ctx.db
        .prepare('select set_commit(:details) as c')
        .get({ details: JSON.stringify([{ name: 'x', value: 1, salt: '' }]) })
    } catch {
      threw = true
    }
    expect(threw, 'expected set_commit to reject an empty-salt leaf').to.be.true
  })

  it('getDisclosedSelective returns null when the registrant has no RegistrantSelective row', async () => {
    const { engine, electionId } = await setupSelectiveTest()
    const result = await engine.getDisclosedSelective(electionId, 'nonexistent-registrant', 'everyone')
    expect(result).to.be.null
  })

  it('getDisclosedSelective reveals only ElectionDisclosurePolicy-permitted fields for the audience; the rest are opaque hidden digests', async () => {
    const { auth, engine, sign, electionId } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] },
        selective: {
          expiration: FUTURE_EXPIRATION,
          details: [
            { name: 'district', value: 'D-9' },
            { name: 'income', value: 55000 },
            { name: 'ssn', value: '123-45-6789' }
          ]
        }
      },
      sign
    )

    // Seed policy: 'district' disclosed to 'everyone', 'income' disclosed only
    // to the 'district' audience, 'ssn' never declared (stays hidden either way).
    await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'district', audience: 'everyone' }, sign)
    await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'income', audience: 'district' }, sign)

    const everyoneView = await engine.getDisclosedSelective(electionId, registrantId, 'everyone')
    expect(everyoneView, 'expected a disclosure result').to.not.be.null
    expect(everyoneView!.disclosed.map((l) => l.name)).to.deep.equal(['district'])
    expect(everyoneView!.hidden).to.have.length(2)
    // Hidden entries are opaque base64url digests, never the raw name/value/salt.
    for (const hidden of everyoneView!.hidden) {
      expect(hidden).to.be.a('string')
      expect(everyoneView!.disclosed.some((l) => l.value === hidden)).to.be.false
    }

    const districtView = await engine.getDisclosedSelective(electionId, registrantId, 'district')
    expect(districtView!.disclosed.map((l) => l.name).sort()).to.deep.equal(['district', 'income'])
    expect(districtView!.hidden).to.have.length(1)
  })

  it('the returned {disclosed,hidden} subset verifies against the bare set_commit root via setVerify (true genuine, false tampered)', async () => {
    const { auth, engine, sign, electionId } = await setupSelectiveTest()
    const registrantId = nextRegistrantId()

    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] },
        selective: {
          expiration: FUTURE_EXPIRATION,
          details: [
            { name: 'district', value: 'D-9' },
            { name: 'income', value: 55000 }
          ]
        }
      },
      sign
    )
    await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'district', audience: 'everyone' }, sign)

    const disclosure = await engine.getDisclosedSelective(electionId, registrantId, 'everyone')
    expect(disclosure).to.not.be.null

    const genuine = setVerify(disclosure!.root, { disclosed: disclosure!.disclosed, hidden: disclosure!.hidden })
    expect(genuine, 'a genuine disclosure must verify true').to.be.true

    const tampered = setVerify(disclosure!.root, {
      disclosed: disclosure!.disclosed.map((l, i) => (i === 0 ? { ...l, value: 'TAMPERED' } : l)),
      hidden: disclosure!.hidden
    })
    expect(tampered, 'a tampered disclosed value must verify false').to.be.false
  })

  describe('MockRegistrationEngine parity', () => {
    it('register() with a selective payload + getDisclosedSelective round-trip through setVerify', async () => {
      const { MockRegistrationEngine } = await import('../src/registration/mock-registration-engine.js')
      const mock = new MockRegistrationEngine()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      const electionId = 'election-mock-selective-1'
      const registrantId = 'registrant-mock-selective-1'

      await mock.register(
        {
          registrant: { id: registrantId, authorityId: 'authority-mock-1', expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] },
          selective: { expiration: FUTURE_EXPIRATION, details: [{ name: 'district', value: 'D-9' }] }
        },
        dummySig
      )

      const registrant = await mock.getRegistrant(registrantId)
      expect(registrant!.selectiveCid).to.be.a('string')
      const selective = await mock.getRegistrantSelective(registrantId)
      expect(selective!.selectiveDetails).to.have.length(1)

      await mock.addElectionDisclosurePolicy({ electionId, fieldName: 'district', audience: 'everyone' }, dummySig)
      const disclosure = await mock.getDisclosedSelective(electionId, registrantId, 'everyone')
      expect(disclosure).to.not.be.null
      expect(disclosure!.disclosed.map((l) => l.name)).to.deep.equal(['district'])
      expect(setVerify(disclosure!.root, { disclosed: disclosure!.disclosed, hidden: disclosure!.hidden })).to.be.true
    })
  })
})
