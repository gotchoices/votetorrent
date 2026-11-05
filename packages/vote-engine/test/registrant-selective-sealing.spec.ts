/**
 * registrant-selective-sealing.spec.ts — Phase 62 Plan 36 Task 2 (D-52, T-62-31-13).
 *
 * The single-DB proof that `RegistrantSelective.SelectiveDetails` is stored sealed (one vt-env-1
 * envelope, to the officers current at write time), that every reader opens it in memory with the
 * plaintext-Cid recheck (`cid(set_commit(plaintext)) === Cid`, replacing the CidValid CHECK 62-33
 * dropped), and that failure modes fail closed. S1, S3, S4, S6b and S11 are RED on the unsealed engine.
 */

import { expect } from 'chai'
import { setVerify } from '@optimystic/quereus-plugin-crypto'
import type { RegisterInit, SelectiveLeaf, Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { isSealedRegistrationContent, sealRegistrantSelectiveDetails } from '../src/registration/sealed-registration-content.js'
import { envelopeRecipientUserIds } from '../src/crypto/index.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import { toDeferredCheckDatetime, toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'
import {
  addTestAuthority,
  addTestElection,
  createTestNetwork,
  makeTestOutsiderOpener,
  makeTestSignCallback,
  provisionTestIntakeRecipient
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'

const FUTURE = Date.now() + 365 * 86_400_000

function randomMarker (): string {
  return `MARKER-D52-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

// Captured across the WHOLE file (S11 tripwire).
const consoleCalls: string[] = []
const thrownMessages: string[] = []
const markers: string[] = []
const originalConsole = { log: console.log, warn: console.warn, error: console.error }
before(() => {
  console.log = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
  console.warn = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
  console.error = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
})
after(() => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
})

async function freshAuthority (provision: boolean): Promise<TestAuthorityContext> {
  const auth = await addTestAuthority(await createTestNetwork())
  if (provision) await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  return auth
}

function selectiveInit (authorityId: string, registrantId: string, details: Array<{ name: string; value: string | number }>): RegisterInit {
  return {
    registrant: { id: registrantId, authorityId, expiration: FUTURE },
    private: { expiration: FUTURE, details: [] },
    selective: { expiration: FUTURE, details }
  }
}

async function rawSelective (ctx: EngineContext, registrantId: string): Promise<{ SelectiveDetails: string; Cid: string } | undefined> {
  const row = await ctx.db.prepare('select SelectiveDetails, Cid from RegistrantSelective where RegistrantId = :registrantId').get({ registrantId })
  return row as { SelectiveDetails: string; Cid: string } | undefined
}

async function makeLeaves (ctx: EngineContext, values: Array<[string, string | number]>): Promise<SelectiveLeaf[]> {
  const out: SelectiveLeaf[] = []
  for (const [name, value] of values) {
    const row = await ctx.db.prepare('select random_bytes(128) as s').get({})
    out.push({ name, value, salt: String(row!.s) } as SelectiveLeaf)
  }
  return out
}

async function cidOf (ctx: EngineContext, leaves: unknown): Promise<string> {
  const row = await ctx.db.prepare('select cid(set_commit(:plaintextLeaves)) as c').get({ plaintextLeaves: JSON.stringify(leaves) })
  return row!.c as string
}

/** A bare Registrant whose SelectiveCid is `selectiveCid`, plus a RAW vrg-signed RegistrantSelective row (engine digest shape). */
async function rawRegistrantWithSelective (
  auth: TestAuthorityContext,
  engine: RegistrationEngine,
  registrantId: string,
  cid: string,
  storedText: string
): Promise<void> {
  const ctx = auth.ctx
  const sign = makeTestSignCallback(auth.user)
  const privateCid = await (engine as unknown as {
    computeRegistrantPrivateCid: (id: string, a: { expiration: number; storedDetails: string }) => Promise<string>
  }).computeRegistrantPrivateCid(registrantId, { expiration: FUTURE, storedDetails: '[]' })
  await engine.createRegistrant({ id: registrantId, authorityId: auth.authority.id, privateCid, selectiveCid: cid, expiration: FUTURE }, sign)

  const tid = await allocateTid(ctx.db, 'registration')
  const digestParams = { tid, cid, registrantId, expirationDeferred: toDeferredCheckDatetime(FUTURE), selectiveDetails: storedText }
  const nonce = await seedSignedMutation(
    ctx, auth.authority.id, 'vrg', tid,
    'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :selectiveDetails) as d', digestParams, sign
  )
  await ctx.db.exec(
    `insert into RegistrantSelective (Cid, RegistrantId, Expiration, SelectiveDetails)
     with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
     values (:cid, :registrantId, :expiration, :selectiveDetails)`,
    { cid, registrantId, expiration: toIsoZDatetime(FUTURE), selectiveDetails: storedText, signingNonce: nonce, now: nowCanonicalDatetime() }
  )
}

async function rawRegistrantRowViaInsert (engine: RegistrationEngine, id: string, cid: string, sign: unknown): Promise<void> {
  const priv = engine as unknown as {
    insertRegistrantSelectiveRow: (r: string, e: number, l: SelectiveLeaf[], s: string, c: string, sg: unknown) => Promise<unknown>
  }
  await priv.insertRegistrantSelectiveRow(id, FUTURE, [], '[]', cid, sign)
}

describe('registrant-selective-sealing — D-52 (62-36 Task 2)', function () {
  this.timeout(60_000)

  describe('S1 — sealed write', () => {
    it('raw column holds no marker/salt, is sealed to the officers, Cid equals SelectiveCid and set_commit of the opened leaves', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const marker = randomMarker()
      markers.push(marker)
      const registrantId = crypto.randomUUID()
      await engine.register(selectiveInit(auth.authority.id, registrantId, [{ name: 'income', value: marker }, { name: 'dob', value: '1990-01-01' }]), makeTestSignCallback(auth.user))

      const raw = await rawSelective(auth.ctx, registrantId)
      expect(raw).to.not.be.undefined
      expect(raw!.SelectiveDetails).to.not.include(marker)
      expect(raw!.SelectiveDetails).to.not.include('"salt"')
      expect(isSealedRegistrationContent(raw!.SelectiveDetails)).to.equal(true)
      expect(envelopeRecipientUserIds(raw!.SelectiveDetails)).to.have.members([auth.user.id])

      const registrant = await engine.getRegistrant(registrantId)
      expect(raw!.Cid).to.equal(registrant!.selectiveCid)
      const read = await engine.getRegistrantSelective(registrantId)
      expect(read!.detailsAccess).to.equal('opened')
      expect(raw!.Cid).to.equal(await cidOf(auth.ctx, read!.selectiveDetails))
      for (const leaf of read!.selectiveDetails!) markers.push(String(leaf.salt))
    })
  })

  describe('S2 — officer read', () => {
    it('opened leaves with the marker; getDisclosedSelective discloses the policy field and the root verifies', async () => {
      const auth = await freshAuthority(true)
      const elec = await addTestElection(auth)
      const electionRow = await elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: elec.authority.id })
      const electionId = electionRow!.Id as string
      const engine = new RegistrationEngine(auth.ctx)
      const sign = makeTestSignCallback(auth.user)
      const marker = randomMarker()
      markers.push(marker)
      const registrantId = crypto.randomUUID()
      await engine.register(selectiveInit(auth.authority.id, registrantId, [{ name: 'district', value: marker }, { name: 'ssn', value: '123' }]), sign)
      await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'district', audience: 'everyone' }, sign)

      const read = await engine.getRegistrantSelective(registrantId)
      expect(read!.detailsAccess).to.equal('opened')
      expect(read!.selectiveDetails!.find((l) => l.name === 'district')!.value).to.equal(marker)

      const view = await engine.getDisclosedSelective(electionId, registrantId, 'everyone')
      expect(view!.access).to.equal('opened')
      expect(view!.disclosed.map((l) => l.name)).to.deep.equal(['district'])
      expect(view!.hidden).to.have.length(1)
      expect(setVerify(view!.root, { disclosed: view!.disclosed, hidden: view!.hidden } as never)).to.equal(true)
    })
  })

  async function unreadCase (opener: 'none' | 'outsider', expected: 'no-opener' | 'not-a-recipient'): Promise<void> {
    const auth = await freshAuthority(true)
    const elec = await addTestElection(auth)
    const electionRow = await elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: elec.authority.id })
    const electionId = electionRow!.Id as string
    const sign = makeTestSignCallback(auth.user)
    const writer = new RegistrationEngine(auth.ctx)
    const registrantId = crypto.randomUUID()
    await writer.register(selectiveInit(auth.authority.id, registrantId, [{ name: 'district', value: 'D-9' }]), sign)
    await writer.addElectionDisclosurePolicy({ electionId, fieldName: 'district', audience: 'everyone' }, sign)

    const intakeOpener = opener === 'none' ? undefined : (await makeTestOutsiderOpener()).opener
    const reader = new RegistrationEngine({ db: auth.ctx.db, user: auth.ctx.user, intakeOpener })
    const read = await reader.getRegistrantSelective(registrantId)
    expect(read!.detailsAccess).to.equal(expected)
    expect(read!.selectiveDetails).to.equal(undefined)
    const view = await reader.getDisclosedSelective(electionId, registrantId, 'everyone')
    expect(view).to.not.equal(null)
    expect(view!.access).to.equal(expected)
    expect(view!.disclosed).to.deep.equal([])
    expect(view!.hidden).to.deep.equal([])
    expect(view!.root).to.equal('')
  }

  describe('S3 — no opener', () => {
    it('no-opener everywhere; nothing throws, no partial value', async () => { await unreadCase('none', 'no-opener') })
  })

  describe('S4 — non-recipient', () => {
    it('not-a-recipient everywhere', async () => { await unreadCase('outsider', 'not-a-recipient') })
  })

  describe('S5 — tampered sealed row', () => {
    it('envelope holding L2 under Cid(L1) reads tampered and discloses nothing', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const l1 = await makeLeaves(auth.ctx, [['a', 'one']])
      const l2 = await makeLeaves(auth.ctx, [['a', 'two']])
      const cid1 = await cidOf(auth.ctx, l1)
      const registrantId = crypto.randomUUID()
      const sealed = await sealRegistrantSelectiveDetails(auth.ctx.db, { authorityId: auth.authority.id, registrantId, cid: cid1, leaves: l2 })
      await rawRegistrantWithSelective(auth, engine, registrantId, cid1, sealed)
      const read = await engine.getRegistrantSelective(registrantId)
      expect(read!.detailsAccess).to.equal('tampered')
      expect(read!.selectiveDetails).to.equal(undefined)
    })
  })

  describe('S6 — legacy plaintext rows', () => {
    it('matching Cid reads unsealed and discloses; S6b mismatching Cid reads tampered', async () => {
      const auth = await freshAuthority(true)
      const elec = await addTestElection(auth)
      const electionRow = await elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: elec.authority.id })
      const electionId = electionRow!.Id as string
      const engine = new RegistrationEngine(auth.ctx)
      await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'a', audience: 'everyone' }, makeTestSignCallback(auth.user))

      const leaves = await makeLeaves(auth.ctx, [['a', 'one'], ['b', 'two']])
      const cid = await cidOf(auth.ctx, leaves)
      const idOk = crypto.randomUUID()
      await rawRegistrantWithSelective(auth, engine, idOk, cid, JSON.stringify(leaves))
      const ok = await engine.getRegistrantSelective(idOk)
      expect(ok!.detailsAccess).to.equal('unsealed')
      expect(ok!.selectiveDetails).to.deep.equal(leaves)
      const view = await engine.getDisclosedSelective(electionId, idOk, 'everyone')
      expect(view!.access).to.equal('unsealed')
      expect(view!.disclosed.map((l) => l.name)).to.deep.equal(['a'])

      // S6b: plaintext leaves L2 stored under Cid(L1)
      const l1 = await makeLeaves(auth.ctx, [['a', 'x']])
      const cid1 = await cidOf(auth.ctx, l1)
      const idBad = crypto.randomUUID()
      await rawRegistrantWithSelective(auth, engine, idBad, cid1, JSON.stringify(leaves))
      const bad = await engine.getRegistrantSelective(idBad)
      expect(bad!.detailsAccess).to.equal('tampered')
      expect(bad!.selectiveDetails).to.equal(undefined)
    })
    it('S6b is also tampered through getDisclosedSelective (empty disclosure, root empty)', async () => {
      const auth = await freshAuthority(true)
      const elec = await addTestElection(auth)
      const electionRow = await elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: elec.authority.id })
      const electionId = electionRow!.Id as string
      const engine = new RegistrationEngine(auth.ctx)
      const leaves = await makeLeaves(auth.ctx, [['a', 'one']])
      const cid1 = await cidOf(auth.ctx, await makeLeaves(auth.ctx, [['a', 'x']]))
      const id = crypto.randomUUID()
      await rawRegistrantWithSelective(auth, engine, id, cid1, JSON.stringify(leaves))
      const view = await engine.getDisclosedSelective(electionId, id, 'everyone')
      expect(view!.access).to.equal('tampered')
      expect(view!.disclosed).to.deep.equal([])
      expect(view!.root).to.equal('')
    })
  })

  describe('S7 — zero recipients', () => {
    it('rejects IntakeError no-recipients before any signature or write', async () => {
      const auth = await freshAuthority(false)
      const engine = new RegistrationEngine(auth.ctx)
      const realSign = makeTestSignCallback(auth.user)
      let calls = 0
      const sign = async (d: Uint8Array): Promise<Signature> => { calls += 1; return realSign(d) }
      const before = await auth.ctx.db.prepare('select count(*) as n from Registrant').get({})
      let caught: unknown
      try {
        await engine.register(selectiveInit(auth.authority.id, crypto.randomUUID(), [{ name: 'a', value: 'b' }]), sign)
      } catch (err) {
        caught = err
        thrownMessages.push(String((err as Error).message))
      }
      expect((caught as Error)?.name).to.equal('IntakeError')
      expect((caught as { code?: string }).code).to.equal('no-recipients')
      expect(calls).to.equal(0)
      const after = await auth.ctx.db.prepare('select count(*) as n from Registrant').get({})
      expect(Number(after!.n)).to.equal(Number(before!.n))
    })
  })

  describe('S8 — seal once', () => {
    it('exactly one row; InsertValid accepted the sealed text; SelectiveCid matches', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const registrantId = crypto.randomUUID()
      await engine.register(selectiveInit(auth.authority.id, registrantId, [{ name: 'a', value: 1 }, { name: 'b', value: 2 }]), makeTestSignCallback(auth.user))
      const n = await auth.ctx.db.prepare('select count(*) as n from RegistrantSelective where RegistrantId = :registrantId').get({ registrantId })
      expect(Number(n!.n)).to.equal(1)
      const raw = await rawSelective(auth.ctx, registrantId)
      expect(isSealedRegistrationContent(raw!.SelectiveDetails)).to.equal(true)
      expect((await engine.getRegistrant(registrantId))!.selectiveCid).to.equal(raw!.Cid)
    })
  })

  describe('S9 — createRegistrantSelective', () => {
    it('seals the same way and reads opened', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const sign = makeTestSignCallback(auth.user)
      const registrantId = crypto.randomUUID()
      // Parent Registrant carries the Cid the tier row will compute: build leaves via the engine helpers.
      const priv = engine as unknown as {
        buildSelectiveLeaves: (f: Array<{ name: string; value: string }>) => Promise<SelectiveLeaf[]>
        computeRegistrantSelectiveCid: (j: string) => Promise<string>
        computeRegistrantPrivateCid: (id: string, a: { expiration: number; storedDetails: string }) => Promise<string>
        insertRegistrantSelectiveRow: unknown
      }
      const marker = randomMarker()
      markers.push(marker)
      // Stub leaves generation so the parent's Cid is known up front: wrap buildSelectiveLeaves once.
      const leaves = await priv.buildSelectiveLeaves([{ name: 'k', value: marker }])
      const cid = await priv.computeRegistrantSelectiveCid(JSON.stringify(leaves))
      const privateCid = await priv.computeRegistrantPrivateCid(registrantId, { expiration: FUTURE, storedDetails: '[]' })
      await engine.createRegistrant({ id: registrantId, authorityId: auth.authority.id, privateCid, selectiveCid: cid, expiration: FUTURE }, sign)
      priv.buildSelectiveLeaves = async () => leaves
      const created = await engine.createRegistrantSelective({ registrantId, expiration: FUTURE, fields: [{ name: 'k', value: marker }] }, sign)
      expect(created.cid).to.equal(cid)
      expect(created.detailsAccess).to.equal('opened')
      const raw = await rawSelective(auth.ctx, registrantId)
      expect(raw!.SelectiveDetails).to.not.include(marker)
      expect(isSealedRegistrationContent(raw!.SelectiveDetails)).to.equal(true)
      const read = await engine.getRegistrantSelective(registrantId)
      expect(read!.detailsAccess).to.equal('opened')
      expect(read!.selectiveDetails).to.deep.equal(leaves)
    })
  })

  describe('S10 — D-51 late officer', () => {
    it('holders[1] reads a pre-provisioning row not-a-recipient; a later row opens for both', async () => {
      const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }] })
      await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
      const engine = new RegistrationEngine(fx.elec.ctx)
      const early = crypto.randomUUID()
      await engine.register(selectiveInit(fx.authorityId, early, [{ name: 'a', value: 'early' }]), fx.holders[0]!.sign)

      const holder1Ctx: EngineContext = { db: fx.elec.ctx.db, user: fx.holders[1]!.user }
      await provisionTestIntakeRecipient(holder1Ctx, fx.authorityId)
      const holder1Engine = new RegistrationEngine({ db: fx.elec.ctx.db, user: fx.holders[1]!.user, intakeOpener: holder1Ctx.intakeOpener })
      expect((await holder1Engine.getRegistrantSelective(early))!.detailsAccess).to.equal('not-a-recipient')

      const late = crypto.randomUUID()
      await engine.register(selectiveInit(fx.authorityId, late, [{ name: 'a', value: 'late' }]), fx.holders[0]!.sign)
      expect((await engine.getRegistrantSelective(late))!.detailsAccess).to.equal('opened')
      expect((await holder1Engine.getRegistrantSelective(late))!.detailsAccess).to.equal('opened')
    })
  })

  describe('S12 — empty selective', () => {
    it('no or empty details writes no row and leaves SelectiveCid NULL', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const sign = makeTestSignCallback(auth.user)
      const a = crypto.randomUUID()
      const b = crypto.randomUUID()
      await engine.register({ registrant: { id: a, authorityId: auth.authority.id, expiration: FUTURE }, private: { expiration: FUTURE, details: [] } }, sign)
      await engine.register(selectiveInit(auth.authority.id, b, []), sign)
      for (const id of [a, b]) {
        expect(await rawSelective(auth.ctx, id)).to.equal(undefined)
        expect((await engine.getRegistrant(id))!.selectiveCid).to.equal(undefined)
      }
    })
  })

  describe('S13 — empty selective set round-trips (WR-02)', () => {
    type Priv = {
      buildSelectiveLeaves: (f: Array<{ name: string; value: string }>) => Promise<SelectiveLeaf[]>
      computeRegistrantSelectiveCid: (j: string) => Promise<string>
      computeRegistrantPrivateCid: (id: string, a: { expiration: number; storedDetails: string }) => Promise<string>
      insertRegistrantSelectiveRow: (
        registrantId: string, expiration: number, leaves: SelectiveLeaf[], stored: string, cid: string, sign: unknown
      ) => Promise<unknown>
    }
    async function parent (auth: TestAuthorityContext, engine: RegistrationEngine, id: string): Promise<string> {
      const priv = engine as unknown as Priv
      const cid = await priv.computeRegistrantSelectiveCid('[]')
      const privateCid = await priv.computeRegistrantPrivateCid(id, { expiration: FUTURE, storedDetails: '[]' })
      await engine.createRegistrant({ id, authorityId: auth.authority.id, privateCid, selectiveCid: cid, expiration: FUTURE }, makeTestSignCallback(auth.user))
      return cid
    }

    it('S13 new empty: create, get and disclosed all report unsealed with an empty leaf list', async () => {
      const auth = await freshAuthority(true)
      const elec = await addTestElection(auth)
      const electionRow = await elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: elec.authority.id })
      const electionId = electionRow!.Id as string
      const engine = new RegistrationEngine(auth.ctx)
      const sign = makeTestSignCallback(auth.user)
      const id = crypto.randomUUID()
      await parent(auth, engine, id)
      const created = await engine.createRegistrantSelective({ registrantId: id, expiration: FUTURE, fields: [] }, sign)
      expect(created.detailsAccess).to.equal('unsealed')
      expect(created.selectiveDetails).to.deep.equal([])
      expect((await rawSelective(auth.ctx, id))!.SelectiveDetails).to.equal('[]')
      const read = await engine.getRegistrantSelective(id)
      expect(read!.detailsAccess).to.equal('unsealed')
      expect(read!.selectiveDetails).to.deep.equal([])
      const view = await engine.getDisclosedSelective(electionId, id, 'everyone')
      expect(view!.access).to.equal('unsealed')
      expect(view!.disclosed).to.deep.equal([])
      expect(view!.hidden).to.deep.equal([])
      expect(view!.root).to.not.equal('')
    })

    it('S13b legacy [] row written through the raw insert path reads unsealed', async () => {
      const auth = await freshAuthority(true)
      const engine = new RegistrationEngine(auth.ctx)
      const id = crypto.randomUUID()
      const cid = await parent(auth, engine, id)
      await rawRegistrantRowViaInsert(engine, id, cid, makeTestSignCallback(auth.user))
      const read = await engine.getRegistrantSelective(id)
      expect(read!.detailsAccess).to.equal('unsealed')
      expect(read!.selectiveDetails).to.deep.equal([])
    })
  })

  describe('S11 — no leak', () => {
    it('no console call or thrown message captured a marker or salt', () => {
      expect(markers.length).to.be.greaterThan(0)
      for (const text of [...consoleCalls, ...thrownMessages]) {
        for (const m of markers) expect(text).to.not.include(m)
      }
    })
  })
})
