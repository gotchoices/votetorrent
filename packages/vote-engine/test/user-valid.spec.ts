// user-valid.spec.ts — D-21 Class A (IsUserValid) rejection specs.
//
// `ProposedAdmin.UserValid` (packages/vote-core/schema/votetorrent.qsql:419)
// is `check (context.IsUserValid = true)`. `AuthorityEngine.proposeAdmin`
// (`authority-engine.ts:409-`) binds a REAL, computed `IsUserValid` (49-08):
// the conjunction of `verifyUserKeyMembership` (registered, unexpired
// UserKey row) and a curve-dispatched signature verification over the
// canonical digest. These cases assert that behavior: an unregistered
// signer key is rejected, an expired signer key is rejected, and a
// registered/unexpired signer with a real verifying signature still
// succeeds.

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { digestToBytes, toCanonicalDatetime } from '../src/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  signTestDigest,
  makeElectionInit
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { ElectionsEngine } from '../src/elections/elections-engine.js'
import type { EngineContext } from '../src/types.js'
import { ElectionEvent, ElectionType, UserKeyType } from '@votetorrent/vote-core'
import type { AdminInit, Proposal, Scope, Signature } from '@votetorrent/vote-core'

describe('IsUserValid — ProposedAdmin Class A signer/key gate (D-21)', () => {
  it('case 1: proposeAdmin with a signer key that has NO matching UserKey row is REJECTED', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    // A real signature, but over an UNREGISTERED keypair — no UserKey row
    // anywhere references this public key.
    const unregistered = randomTestKeyPair()
    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)

    const digestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({
        authorityId: auth.authority.id,
        effectiveAt: effectiveAtCanon,
        thresholdPolicies: thresholdPoliciesJson
      })
    if (!digestRow || digestRow.d == null) throw new Error('case 1: Digest() returned null')
    const digestBytes = digestToBytes(digestRow.d as string)
    const sigHex = bytesToHex(secp256k1.sign(digestBytes, hexToBytes(unregistered.privateHex)))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }
    const sig: Signature = { signerUserId: auth.user.id, signerKey: unregistered.publicHex, signature: sigHex }

    let threw = false
    try {
      await auth.authorityEngine.proposeAdmin(proposal, sig)
    } catch {
      threw = true
    }
    expect(threw, 'proposeAdmin with an unregistered signer key must reject').to.be.true
  })

  it('case 2: proposeAdmin with a registered signer key whose Expiration is in the PAST is REJECTED', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    // Seed a second, EXPIRED UserKey row for the seeded user. Insert-time
    // ExpirationFuture (`Expiration > context.now`) is satisfied by binding
    // an artificially EARLY `now` alongside the past Expiration — the row is
    // genuinely expired relative to real wall-clock time thereafter.
    const expiredKey = randomTestKeyPair()
    const insertNow = new Date(Date.now() - 2 * 86_400_000)
    const pastExpiration = new Date(Date.now() - 86_400_000)
    const digestRow = await ctx.db
      .prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
      .get({
        userId: auth.user.id,
        pubKey: expiredKey.publicHex,
        type: 'M',
        expiration: toCanonicalDatetime(pastExpiration)
      })
    if (!digestRow || digestRow.d == null) throw new Error('case 2: Digest() returned null')
    const existingKeySig = signTestDigest(auth.user, digestRow.d as string)

    await ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
       values (:userId, 'M', :pubKey, :expiration)`,
      {
        userId: auth.user.id,
        pubKey: expiredKey.publicHex,
        expiration: toCanonicalDatetime(pastExpiration),
        userKey: existingKeySig.signerKey,
        signature: existingKeySig.signature,
        now: toCanonicalDatetime(insertNow)
      }
    )

    // Now propose admin, signed by the EXPIRED key.
    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)
    const adminDigestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({ authorityId: auth.authority.id, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson })
    if (!adminDigestRow || adminDigestRow.d == null) throw new Error('case 2: admin Digest() returned null')
    const adminDigestBytes = digestToBytes(adminDigestRow.d as string)
    const sigHex = bytesToHex(secp256k1.sign(adminDigestBytes, hexToBytes(expiredKey.privateHex)))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }
    const sig: Signature = { signerUserId: auth.user.id, signerKey: expiredKey.publicHex, signature: sigHex }

    let threw = false
    try {
      await auth.authorityEngine.proposeAdmin(proposal, sig)
    } catch {
      threw = true
    }
    expect(threw, 'proposeAdmin signed by an expired UserKey must reject').to.be.true
  })

  it('case 3 (positive control): proposeAdmin with a registered, unexpired signer key and a real verifying signature SUCCEEDS', async () => {
    // This case must ALSO pass under today's vacuous CHECK — a regression in
    // the positive path is attributable independent of the D-21 fix.
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)
    // 57-01 (D-02): proposeAdmin now folds the resolved roster into the
    // digest too. Mirror the engine's '.existing' name-bridge (User.Name)
    // instead of hardcoding it, so this stays correct if the fixture's
    // seeded user name ever changes.
    const userRow = await ctx.db.prepare('select Name from User where Id = :id').get({ id: auth.user.id })
    // 57-13 (CR-01): sortRosterEntries now serializes an explicit userId key
    // (null for '.init' officers) — this '.existing' officer's userId must be
    // supplied here too, or the digest this test pre-computes and signs will
    // not match what proposeAdmin recomputes engine-side via resolveAdminRoster.
    const officersJson = JSON.stringify([{ proposedName: userRow?.Name as string, userId: auth.user.id, title: 'Chair', scopes: ['rad'] }])
    const digestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
      .get({
        authorityId: auth.authority.id,
        effectiveAt: effectiveAtCanon,
        officers: officersJson,
        thresholdPolicies: thresholdPoliciesJson
      })
    if (!digestRow || digestRow.d == null) throw new Error('case 3: Digest() returned null')
    const sig = signTestDigest(auth.user, digestRow.d as string)

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }

    await auth.authorityEngine.proposeAdmin(proposal, sig)

    const row = await ctx.db
      .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
      .get({ id: auth.authority.id, e: effectiveAtCanon })
    expect(Number(row?.n)).to.equal(1)
  })
})

// 49-09 D-21 Class B: the six sites closed this plan carry no `Signature`
// argument, so `verifyUserKeyMembership`'s membership-and-non-expiry result
// is the WHOLE of "real IsUserValid" here — not one conjunct of a
// signature check, as it is for the Class A `proposeAdmin` cases above. Each
// describe block below covers one of the five live `ProposedX` write paths
// with a rejection case (userId/userKey absent from `UserKey`) plus a
// positive control (the network's own registered founding key).

describe('IsUserValid — ProposedNetwork Class B membership gate (D-21)', () => {
  it('rejects NetworkEngine.proposeRevision when the signer key has NO matching UserKey row', async () => {
    const net = await createTestNetwork()
    const unregistered = randomTestKeyPair()
    net.ctx.user = {
      ...net.user,
      activeKeys: [
        { key: unregistered.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      ]
    }

    let threw = false
    try {
      await net.networkEngine.proposeRevision({
        name: 'Ghost Revision',
        relays: [],
        policies: { timestampAuthorities: [], numberRequiredTSAs: 1, electionType: ElectionType.adhoc }
      })
    } catch {
      threw = true
    }
    expect(threw, 'proposeRevision with an unregistered signer key must reject').to.be.true

    const row = await net.ctx.db
      .prepare('select 1 from ProposedNetwork where Name = :n')
      .get({ n: 'Ghost Revision' })
    expect(row, 'no ProposedNetwork row should be written on rejection').to.equal(undefined)
  })

  it('(positive control) NetworkEngine.proposeRevision with the registered founding key SUCCEEDS', async () => {
    const net = await createTestNetwork()
    await net.networkEngine.proposeRevision({
      name: 'Real Revision',
      relays: [],
      policies: { timestampAuthorities: [], numberRequiredTSAs: 1, electionType: ElectionType.adhoc }
    })
    const row = await net.ctx.db
      .prepare('select Name from ProposedNetwork where Name = :n')
      .get({ n: 'Real Revision' })
    expect(row?.Name).to.equal('Real Revision')
  })
})

describe('IsUserValid — ProposedElection Class B membership gate (D-21, adjustElection)', () => {
  it('rejects ElectionsEngine.adjustElection when the signer key has NO matching UserKey row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const unregistered = randomTestKeyPair()
    auth.ctx.user = {
      ...auth.user,
      activeKeys: [
        { key: unregistered.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      ]
    }
    const engine = new ElectionsEngine(auth.ctx)

    let threw = false
    try {
      await engine.adjustElection(makeElectionInit({ authorityId: auth.authority.id }))
    } catch {
      threw = true
    }
    expect(threw, 'adjustElection with an unregistered signer key must reject').to.be.true

    const row = await auth.ctx.db
      .prepare('select 1 from ProposedElection where Id = :id')
      .get({ id: 'election-1' })
    expect(row, 'no ProposedElection row should be written on rejection').to.equal(undefined)
  })

  it('(positive control) ElectionsEngine.adjustElection with the registered founding key SUCCEEDS', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const engine = new ElectionsEngine(auth.ctx)
    await engine.adjustElection(makeElectionInit({ authorityId: auth.authority.id }))

    const core = await auth.ctx.db
      .prepare('select Id from ProposedElection where Id = :id')
      .get({ id: 'election-1' })
    expect(core?.Id).to.equal('election-1')
  })
})

describe('IsUserValid — ProposedElectionRevision Class B membership gate (D-21, election-engine proposeRevision)', () => {
  it('rejects ElectionEngine.proposeRevision when the signer key has NO matching UserKey row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const unregistered = randomTestKeyPair()
    elCtx.ctx.user = {
      ...elCtx.user,
      activeKeys: [
        { key: unregistered.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      ]
    }

    let threw = false
    try {
      await elCtx.electionEngine.proposeRevision({
        electionId: 'election-1',
        revision: 1,
        revisionTimestamp: Date.now(),
        tags: ['ghost'],
        instructions: '# Ghost',
        keyholders: [],
        timeline: {} as Record<ElectionEvent, number>,
        keyholderThreshold: 1
      })
    } catch {
      threw = true
    }
    expect(threw, 'proposeRevision with an unregistered signer key must reject').to.be.true

    const row = await elCtx.ctx.db
      .prepare('select 1 from ProposedElectionRevision where ElectionId = :id and Revision = :rev')
      .get({ id: 'election-1', rev: 1 })
    expect(row, 'no ProposedElectionRevision row should be written on rejection').to.equal(undefined)
  })

  it('(positive control) ElectionEngine.proposeRevision with the registered founding key SUCCEEDS', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    await elCtx.electionEngine.proposeRevision({
      electionId: 'election-1',
      revision: 1,
      revisionTimestamp: Date.now(),
      tags: ['amended'],
      instructions: '# Revised',
      keyholders: [],
      timeline: {} as Record<ElectionEvent, number>,
      keyholderThreshold: 1
    })
    const row = await elCtx.ctx.db
      .prepare('select Revision from ProposedElectionRevision where ElectionId = :id')
      .get({ id: 'election-1' })
    expect(row?.Revision).to.equal(1)
  })
})

describe('IsUserValid — ProposedBallot Class B membership gate (D-21, election-engine proposeBallot)', () => {
  it('rejects ElectionEngine.proposeBallot when the signer key has NO matching UserKey row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const unregistered = randomTestKeyPair()
    elCtx.ctx.user = {
      ...elCtx.user,
      activeKeys: [
        { key: unregistered.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      ]
    }

    let threw = false
    try {
      await elCtx.electionEngine.proposeBallot({
        id: 'ghost-ballot',
        electionId: 'election-1',
        authorityId: auth.authority.id,
        description: 'Ghost ballot',
        districts: ['d1'],
        questions: []
      })
    } catch {
      threw = true
    }
    expect(threw, 'proposeBallot with an unregistered signer key must reject').to.be.true

    const row = await elCtx.ctx.db
      .prepare('select 1 from ProposedBallot where Id = :id')
      .get({ id: 'ghost-ballot' })
    expect(row, 'no ProposedBallot row should be written on rejection').to.equal(undefined)
  })

  it('(positive control) ElectionEngine.proposeBallot with the registered founding key SUCCEEDS', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    await elCtx.electionEngine.proposeBallot({
      id: 'ballot-1',
      electionId: 'election-1',
      authorityId: auth.authority.id,
      description: 'Test ballot',
      districts: ['d1'],
      questions: []
    })
    const row = await elCtx.ctx.db
      .prepare('select Description from ProposedBallot where Id = :id')
      .get({ id: 'ballot-1' })
    expect(row?.Description).to.equal('Test ballot')
  })
})
