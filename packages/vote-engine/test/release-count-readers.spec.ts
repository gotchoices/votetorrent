/**
 * release-count-readers.spec.ts (62-29, D-17)
 *
 * Two readers answer "how many keys are released" over the SAME real 3-of-5 DKG:
 *  - the Voter's engine reader, `KeyReleaseEngine.getKeyReleaseStatus().releasedCount` (what the
 *    Voter factory builds: no vault, no user), which validates every row (signature, commitment); and
 *  - the officer roster, `readKeyholders` in `packages/web-data/src/officer/read-keyholders.js`, which
 *    is SQL only and so reports a keyholder's `ReleasedAt` when a release row is PUBLISHED.
 * They agree on honest rows and diverge exactly on a signed bogus share (roster: published; engine:
 * rejected). That is why the roster field is documented as published, not valid.
 *
 * TEST-ONLY cross-package read, in the opposite direction to web-data's dependency on vote-engine,
 * used because only vote-engine's fixtures can build a real signed DKG transcript. No `src/` file in
 * this package imports web-data.
 */

import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Database } from '@quereus/quereus'
import type { EngineContext } from '../src/types.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { dkgIdentifierForUser } from '../src/crypto/dkg.js'
import { digestToBytes } from '../src/utils.js'
import { runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

interface RosterRow { UserId: string, Name: string, ReleasedAt: string | null }
interface RosterModule { readKeyholders: (db: Database, electionId: string, revision: number) => Promise<RosterRow[]> }

async function loadRoster (): Promise<RosterModule> {
  expect(process.cwd().endsWith(path.join('packages', 'vote-engine')), `mocha must run in packages/vote-engine, ran in ${process.cwd()}`).to.equal(true)
  const href = pathToFileURL(path.resolve(process.cwd(), '../web-data/src/officer/read-keyholders.js')).href
  return await import(href) as RosterModule
}

function deviceCtx (db: Database): EngineContext {
  return { db }
}

async function releaseWindow (db: Database, electionId: string): Promise<number> {
  const row = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  const at = releasingKeysAt(JSON.parse(row!.Timeline as string) as Record<string, number>)
  if (at === null) throw new Error('releaseWindow: releasingKeys not set on this fixture')
  return at
}

/** Raw-handle injection of a SIGNED but bogus release row (the schema accepts it; validity is not schema-checked). */
async function postSignedRelease (db: Database, participant: DkgTestParticipant, params: {
  electionId: string, revision: number, identifier: string, signingShare: string, releasedAt: string
}): Promise<void> {
  const { electionId, revision, identifier, signingShare, releasedAt } = params
  const digestRow = await db
    .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
    .get({ electionId, revision, userId: participant.userId, identifier, signingShare, releasedAt })
  if (!digestRow || digestRow.d == null) throw new Error('postSignedRelease: Digest() returned null')
  const signature = await participant.signer.sign(digestToBytes(digestRow.d as string))
  await db.exec(
    `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
     values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
    { electionId, revision, userId: participant.userId, identifier, signingShare, releasedAt, signerKey: signature.signerKey, signature: signature.signature }
  )
}

describe('release-count-readers: engine vs officer roster over a real 3-of-5 DKG', function () {
  this.timeout(240000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number
  let roster: RosterModule

  before(async function () {
    this.timeout(240000)
    roster = await loadRoster()
    elec = await seedDkgElection({ keyholders: ['rc-1', 'rc-2', 'rc-3', 'rc-4', 'rc-5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  const readRoster = async (): Promise<RosterRow[]> => await roster.readKeyholders(elec.auth.ctx.db, elec.electionId, elec.revision)
  const noVaultEngine = (): KeyReleaseEngine => new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))

  it('X1: before any release the engine reports 0 and the roster lists 5 keyholders, all ReleasedAt null', async function () {
    const status = await noVaultEngine().getKeyReleaseStatus(elec.electionId)
    expect(status.releasedCount).to.equal(0)
    const rows = await readRoster()
    expect(rows).to.have.length(5)
    for (const row of rows) expect(row.ReleasedAt).to.equal(null)
  })

  it('X2: after participants 1 and 2 release, the engine counts 2 and the roster shows exactly those two userIds with the stored ReleasedAt', async function () {
    const released = [elec.participants[0]!, elec.participants[1]!]
    for (const p of released) {
      const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p.vault, now: () => at })
      await engine.releaseKeyShare(elec.electionId, p.signer)
    }

    const status = await noVaultEngine().getKeyReleaseStatus(elec.electionId)
    expect(status.releasedCount).to.equal(2)
    expect(status.releasedUserIds).to.deep.equal(released.map((p) => p.userId).sort())

    const rows = await readRoster()
    const published = rows.filter((r) => r.ReleasedAt !== null).map((r) => r.UserId).sort()
    expect(published).to.deep.equal(released.map((p) => p.userId).sort())
    for (const p of released) {
      const stored = await elec.auth.ctx.db.prepare('select ReleasedAt from KeyholderShareRelease where ElectionId = :e and UserId = :u').get({ e: elec.electionId, u: p.userId })
      expect(rows.find((r) => r.UserId === p.userId)!.ReleasedAt).to.equal(stored!.ReleasedAt)
    }
  })

  it('X3: a signed bogus share from participant 3 is PUBLISHED on the roster (3 non-null) but REJECTED by the engine (still 2, share-invalid)', async function () {
    const x = elec.participants[2]!
    await postSignedRelease(elec.auth.ctx.db, x, {
      electionId: elec.electionId,
      revision: elec.revision,
      identifier: dkgIdentifierForUser(x.userId), // x's REAL identifier, so only the share itself is wrong
      signingShare: '07'.repeat(32),
      releasedAt: new Date().toISOString()
    })

    const rows = await readRoster()
    expect(rows.filter((r) => r.ReleasedAt !== null)).to.have.length(3)
    expect(rows.find((r) => r.UserId === x.userId)!.ReleasedAt).to.not.equal(null)

    const status = await noVaultEngine().getKeyReleaseStatus(elec.electionId)
    expect(status.releasedCount).to.equal(2)
    expect(status.releasedUserIds).to.not.include(x.userId)
    const rejection = status.rejectedReleases.find((r) => r.userId === x.userId)
    expect(rejection, 'participant 3 is not listed as rejected').to.not.equal(undefined)
    expect(rejection!.reason).to.equal('share-invalid')
  })

  it('X4: the roster is scoped to live Keyholder rows: no userId outside Keyholder, and exactly the 5 participants', async function () {
    const rows = await readRoster()
    const keyholderIds = new Set<string>()
    for await (const r of elec.auth.ctx.db.eval('select UserId from Keyholder where ElectionId = :e and ElectionRevision = :r', { e: elec.electionId, r: elec.revision })) {
      keyholderIds.add(r.UserId as string)
    }
    expect(rows.length).to.equal(keyholderIds.size)
    for (const row of rows) expect(keyholderIds.has(row.UserId), `${row.UserId} is not a Keyholder`).to.equal(true)
    expect(rows.map((r) => r.UserId).sort()).to.deep.equal(elec.participants.map((p) => p.userId).sort())
  })
})
