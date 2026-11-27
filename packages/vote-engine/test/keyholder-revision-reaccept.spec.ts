/**
 * keyholder-revision-reaccept.spec.ts - phase 62 plan 139 (user ruling 2026-10-07: keep RE-ACCEPT).
 *
 * After an election revision bump a keyholder who accepted the earlier revision has no Keyholder row in the new
 * revision. The projection must say so ('accepted-earlier-revision'), not 'answered' (which the app shows as
 * "Sent"), a new live invitation outranks it, and re-accepting yields a current-revision Keyholder row. History
 * projections (an older projected revision) never read it for an acceptance of that or a later revision.
 */

import { expect } from 'chai'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { KeyholderDkgEngine } from '../src/keyholder/keyholder-dkg-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeTestSignCallback,
  makeElectionInit,
  bumpElectionRevision
} from './fixtures/test-context.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { inviteeContext, invitePrivateForSlot, mintInviteKeyPair } from './fixtures/invite-keys.js'

function makeInvite (name: string, expiration = new Date(Date.now() + 3_600_000).toISOString()): KeyholderInvite {
  return { name, type: 'k', expiration, inviteKey: mintInviteKeyPair().inviteKey, inviteSignature: '' }
}

type SeedRevisionSeam = {
  seedElectionRevisionSigning(
    electionId: string, authorityId: string,
    revision: { revision: number, revisionTimestamp: number, tags: string[], instructions: string, timeline: Record<string, number>, keyholderThreshold: number },
    tid: number, sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<string>
}

async function createElectionWithInvitees (invitees: string[], threshold: number) {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const electionsEngine = new ElectionsEngine(auth.ctx)
  const init = makeElectionInit({ authorityId: auth.authority.id })
  init.revision.keyholders = invitees.map((name) => ({ name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }) as KeyholderInvite)
  init.revision.keyholderThreshold = threshold
  const { election: e } = init
  const pastRevTimestamp = Date.now() - 1000
  const sign = makeTestSignCallback(auth.user)
  const signingNonce = await electionsEngine.seedElectionSigning({
    id: e.id, authorityId: e.authorityId, title: e.title, date: e.date,
    revisionDeadline: e.revisionDeadline, ballotDeadline: e.ballotDeadline, type: e.type
  }, sign)
  const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as unknown as SeedRevisionSeam).seedElectionRevisionSigning(
    e.id, e.authorityId,
    {
      revision: 0, revisionTimestamp: pastRevTimestamp, tags: init.revision.tags, instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>, keyholderThreshold: init.revision.keyholderThreshold
    },
    revTid, sign
  )
  await electionsEngine.createElection(
    { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } },
    { signingNonce, revisionSigningNonce }
  )
  const electionEngine = await electionsEngine.openElection(e.id)
  return { auth, electionsEngine, electionEngine, electionId: e.id }
}

type Fixture = Awaited<ReturnType<typeof createElectionWithInvitees>>

async function send (fx: Fixture, invite: KeyholderInvite): Promise<string> {
  await fx.electionEngine.inviteKeyholder(invite, fx.electionId, makeTestSignCallback(fx.auth.user))
  const row = await fx.auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :slotType')
    .get({ inviteKey: invite.inviteKey, slotType: 'k' })
  return row!.Cid as string
}

async function accept (fx: Fixture, cid: string): Promise<void> {
  await new InvitationEngine(inviteeContext(fx.auth.ctx)).respondToInvite(
    cid, true, await invitePrivateForSlot(fx.auth.ctx, cid), undefined, undefined, makeKeyholderProvisioning()
  )
}

async function projection (fx: Fixture) {
  return (await fx.electionEngine.getElectionDetails()).current.keyholders
}

type ReadRevisionSeam = {
  readRevisionKeyholders(electionId: string, revision: number, keyholdersJson: unknown, field: string): ReturnType<typeof projection>
}

async function projectedAt (fx: Fixture, revision: number | string) {
  const row = await fx.auth.ctx.db.prepare('select Keyholders from ElectionRevision where ElectionId = :id').get({ id: fx.electionId })
  return await (fx.electionEngine as unknown as ReadRevisionSeam).readRevisionKeyholders(
    fx.electionId, revision as number, row!.Keyholders, 'ElectionRevision.Keyholders'
  )
}

async function keyholderUserIds (fx: Fixture): Promise<string[]> {
  const out: string[] = []
  for await (const row of fx.auth.ctx.db.eval('select UserId from Keyholder where ElectionId = :id', { id: fx.electionId })) out.push(row.UserId as string)
  return out.sort()
}

describe('keyholder revision re-accept (62-139)', function () {
  this.timeout(120000)

  it('R1-R4, R6: accepted, bumped, re-invited, re-accepted; history projections never say accept again', async () => {
    const fx = await createElectionWithInvitees(['K1', 'K2'], 2)
    const c1 = await send(fx, makeInvite('K1'))
    const c2 = await send(fx, makeInvite('K2'))
    await accept(fx, c1)
    await accept(fx, c2)

    // R1
    let kh = await projection(fx)
    expect(kh.map((k) => [k.invite.name, k.sent?.state, k.result?.isAccepted])).to.deep.equal([['K1', 'answered', true], ['K2', 'answered', true]])
    const oldIds = await keyholderUserIds(fx)
    expect(oldIds).to.have.length(2)

    // R2
    await bumpElectionRevision({ ...fx.auth, electionsEngine: fx.electionsEngine, electionEngine: fx.electionEngine })
    kh = await projection(fx)
    expect(kh.map((k) => [k.invite.name, k.sent?.state, k.result])).to.deep.equal([
      ['K1', 'accepted-earlier-revision', undefined],
      ['K2', 'accepted-earlier-revision', undefined]
    ])

    // R3: a new live invitation outranks it; K2 is unchanged.
    const n1 = await send(fx, makeInvite('K1'))
    kh = await projection(fx)
    expect(kh.find((k) => k.invite.name === 'K1')!.sent?.state).to.equal('live')
    expect(kh.find((k) => k.invite.name === 'K2')!.sent?.state).to.equal('accepted-earlier-revision')

    // R4: re-accepting with a fresh identity yields current-revision rows.
    await accept(fx, n1)
    const n2 = await send(fx, makeInvite('K2'))
    await accept(fx, n2)
    kh = await projection(fx)
    expect(kh.map((k) => [k.invite.name, k.sent?.state, k.result?.isAccepted])).to.deep.equal([['K1', 'answered', true], ['K2', 'answered', true]])
    const status = await new KeyholderDkgEngine(fx.auth.ctx, { vault: new InMemoryTestKeyVault() }).getDkgStatus(fx.electionId)
    const newIds = (await keyholderUserIds(fx)).filter((id) => !oldIds.includes(id))
    expect(newIds).to.have.length(2)
    expect(status.liveRoster).to.deep.equal(newIds)
    expect(status.earlierRevisionUserIds).to.deep.equal(oldIds)
    expect(status.phase).to.equal('not-started')

    // R6: history projections (a lower projected revision, number or numeric string) never read it.
    const currentRevision = (await fx.electionEngine.getElectionDetails()).current.revision
    for (const projected of [currentRevision - 1, String(currentRevision - 1)]) {
      const hist = await projectedAt(fx, projected)
      expect(hist.map((k) => k.sent?.state), `projected ${projected}`).to.not.include('accepted-earlier-revision')
    }
    const all = await (fx.electionEngine as unknown as { getRevisions (): Promise<Array<{ keyholders: Awaited<ReturnType<typeof projection>> }>> }).getRevisions()
    for (const rev of all) expect(rev.keyholders.map((k) => k.sent?.state)).to.not.include('accepted-earlier-revision')
  })

  it('R5: an acceptor with no Keyholder row anywhere stays answered; a newer decline outranks an older earlier-revision acceptance', async () => {
    const fx = await createElectionWithInvitees(['K1'], 1)
    const c1 = await send(fx, makeInvite('K1'))
    await accept(fx, c1)
    // Delete the acceptor's Keyholder row (not yet replicated / deleted): the answer stays 'answered'.
    const ids = await keyholderUserIds(fx)
    await fx.auth.ctx.db.exec('delete from Keyholder where ElectionId = :id and UserId = :userId', { id: fx.electionId, userId: ids[0]! })
    let kh = await projection(fx)
    expect(kh[0]!.sent?.state).to.equal('answered')

    const fy = await createElectionWithInvitees(['K1'], 1)
    const d1 = await send(fy, makeInvite('K1'))
    await accept(fy, d1)
    await bumpElectionRevision({ ...fy.auth, electionsEngine: fy.electionsEngine, electionEngine: fy.electionEngine })
    // A newer invitation that the invitee declines (later expiration wins at equal rank).
    const later = makeInvite('K1', new Date(Date.now() + 2 * 3_600_000).toISOString())
    const d2 = await send(fy, later)
    await new InvitationEngine(inviteeContext(fy.auth.ctx)).respondToInvite(d2, false, await invitePrivateForSlot(fy.auth.ctx, d2))
    kh = await projection(fy)
    expect(kh[0]!.sent?.state).to.equal('declined')
  })
})
