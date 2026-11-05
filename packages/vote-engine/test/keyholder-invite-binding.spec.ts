/**
 * keyholder-invite-binding.spec.ts - 62-104 (REVIEW/IN-06, O-11).
 *  - Keyholder invitee names are unique within an election (trimmed, NFC, case-insensitive): createElection,
 *    adjustElection and proposeRevision refuse a duplicate with code 'duplicate-keyholder-name', before any write.
 *  - inviteKeyholder refuses an expiration that is not in the future or is more than 7 days (plus 5 minutes of
 *    skew) ahead, code 'invite-expiration-out-of-range', before any write.
 * The legacy-namesake read (a revision that already holds duplicates) is in keyholder-invite-sent-state.spec.ts.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { ElectionInit, ElectionRevisionInit, KeyholderInvite } from '@votetorrent/vote-core'
import { ElectionsEngine } from '../src/elections/elections-engine.js'
import { findDuplicateKeyholderName, normalizeKeyholderName } from '../src/election/keyholder-names.js'
import { addTestAuthority, addTestElection, createTestNetwork, makeElectionInit, makeTestSignCallback } from './fixtures/test-context.js'

function pending (name: string): KeyholderInvite {
  return { name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }
}

async function codeOf (promise: Promise<unknown>): Promise<string | undefined> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  return (caught as { code?: string }).code
}

async function count (db: { eval: (sql: string) => AsyncIterable<unknown> }, table: string): Promise<number> {
  let n = 0
  for await (const _row of db.eval(`select 1 as x from ${table}`)) n += 1
  return n
}

const DUPLICATE_LISTS: Array<{ label: string, names: string[] }> = [
  { label: 'trim and case', names: ['Kay', ' kay '] },
  { label: 'NFC and case', names: ['Káy', 'Káy'] },
]

describe('keyholder-names helpers (62-104)', () => {
  it('normalizes by trim, NFC and case', () => {
    expect(normalizeKeyholderName(' KáY ')).to.equal('káy')
  })
  it('finds the first repeated name and nothing for distinct names', () => {
    expect(findDuplicateKeyholderName(['Kay', 'Lee', ' KAY'])).to.equal(' KAY')
    expect(findDuplicateKeyholderName(['Kay', 'Lee'])).to.equal(undefined)
  })
})

describe('duplicate keyholder names are refused at every revision write (62-104, IN-06)', () => {
  for (const dup of DUPLICATE_LISTS) {
    it(`createElection refuses (${dup.label}) and writes no election`, async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const engine = new ElectionsEngine(auth.ctx)
      const init = makeElectionInit({ authorityId: auth.authority.id })
      init.revision.keyholders = dup.names.map(pending)
      const before = await count(auth.ctx.db, 'Election')
      expect(await codeOf(engine.createElection(init))).to.equal('duplicate-keyholder-name')
      expect(await count(auth.ctx.db, 'Election')).to.equal(before)
    })

    it(`adjustElection refuses (${dup.label}) and writes no proposal`, async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const engine = new ElectionsEngine(auth.ctx)
      const init: ElectionInit = makeElectionInit({ authorityId: auth.authority.id })
      init.revision.keyholders = dup.names.map(pending)
      const before = await count(auth.ctx.db, 'ProposedElection')
      expect(await codeOf(engine.adjustElection(init))).to.equal('duplicate-keyholder-name')
      expect(await count(auth.ctx.db, 'ProposedElection')).to.equal(before)
    })

    it(`proposeRevision refuses (${dup.label}) and writes no revision`, async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const { electionEngine } = await addTestElection(auth)
      const electionId = (await electionEngine.getElectionDetails()).election.id
      const init = makeElectionInit({ authorityId: auth.authority.id })
      const revision: ElectionRevisionInit = { ...init.revision, electionId, revision: 7, keyholders: dup.names.map(pending) }
      const before = await count(auth.ctx.db, 'ProposedElectionRevision')
      expect(await codeOf(electionEngine.proposeRevision(revision))).to.equal('duplicate-keyholder-name')
      expect(await count(auth.ctx.db, 'ProposedElectionRevision')).to.equal(before)
    })
  }

  it('distinct names are accepted by createElection and proposeRevision (positive control)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { electionEngine } = await addTestElection(auth)
    const electionId = (await electionEngine.getElectionDetails()).election.id
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const revision: ElectionRevisionInit = { ...init.revision, electionId, revision: 7, keyholders: ['Kay', 'Lee'].map(pending) }
    const before = await count(auth.ctx.db, 'ProposedElectionRevision')
    await electionEngine.proposeRevision(revision)
    expect(await count(auth.ctx.db, 'ProposedElectionRevision')).to.equal(before + 1)
  })
})

describe('inviteKeyholder expiration bound (62-104, O-11)', () => {
  async function trySend (ms: number): Promise<{ code: string | undefined, slots: number }> {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const { electionEngine } = await addTestElection(auth)
    const electionId = (await electionEngine.getElectionDetails()).election.id
    const invite: KeyholderInvite = {
      name: 'Kay', type: 'k', expiration: new Date(Date.now() + ms).toISOString(),
      inviteKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey())), inviteSignature: '',
    }
    const slotsBefore = await count(auth.ctx.db, 'InviteSlot')
    let code: string | undefined = 'none'
    try {
      await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(auth.user))
      code = undefined
    } catch (err) {
      code = (err as { code?: string }).code
    }
    return { code, slots: (await count(auth.ctx.db, 'InviteSlot')) - slotsBefore }
  }

  it('8 days ahead is refused with no slot', async () => {
    const r = await trySend(8 * 24 * 3600 * 1000)
    expect(r.code).to.equal('invite-expiration-out-of-range')
    expect(r.slots).to.equal(0)
  })

  it('one minute in the past is refused with no slot', async () => {
    const r = await trySend(-60_000)
    expect(r.code).to.equal('invite-expiration-out-of-range')
    expect(r.slots).to.equal(0)
  })

  it('exactly 7 days ahead is accepted', async () => {
    const r = await trySend(7 * 24 * 3600 * 1000)
    expect(r.code).to.equal(undefined)
    expect(r.slots).to.equal(1)
  })

  it('one hour ahead is accepted', async () => {
    const r = await trySend(3_600_000)
    expect(r.code).to.equal(undefined)
    expect(r.slots).to.equal(1)
  })
})
