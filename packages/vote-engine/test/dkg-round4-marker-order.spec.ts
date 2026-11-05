/**
 * Round 4 must delete the stale share-attempt marker BEFORE it stores a fresh share, on every
 * branch (review finding gap1/IN-01). With the old order (put share, then delete marker) a crash
 * between the two left a fresh share labelled with an aborted attempt's marker, which the V-1
 * sweep (`cleanupVault`) would then delete.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import {
  InMemoryTestKeyVault,
  KEYHOLDER_SHARE_ATTEMPT_POLICY,
  keyholderDkgShareAlias,
  keyholderDkgShareAttemptAlias,
  type IKeyVault
} from '../src/crypto/vault.js'
import { KeyholderDkgEngine } from '../src/keyholder/keyholder-dkg-engine.js'
import { runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

async function countRows (db: Database, electionId: string, revision: number, attempt: number, round: number): Promise<number> {
  const row = await db
    .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = :dkgRound')
    .get({ electionId, revision, attempt, dkgRound: round })
  return (row?.c as number | undefined) ?? 0
}

async function awaitingRound4 (db: Database, electionId: string, revision: number, participants: DkgTestParticipant[], attempt = 1): Promise<DkgTestParticipant> {
  for (const p of participants) {
    const row = await db
      .prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = 4 and SenderUserId = :senderUserId')
      .get({ electionId, revision, attempt, senderUserId: p.userId })
    if (!row) return p
  }
  throw new Error('every participant already posted round 4')
}

/** Delegating vault whose delete of `failAlias` throws until `armed` is cleared. */
function flakyVault (base: InMemoryTestKeyVault, failAlias: string): { vault: IKeyVault, disarm: () => void } {
  let armed = true
  const vault: IKeyVault = {
    putSecret: (alias, secret, policy) => base.putSecret(alias, secret, policy),
    getSecret: async (alias) => base.getSecret(alias),
    hasSecret: async (alias) => base.hasSecret(alias),
    deleteSecret: async (alias) => {
      if (armed && alias === failAlias) throw new Error('simulated crash at marker delete')
      return base.deleteSecret(alias)
    }
  } as IKeyVault
  return { vault, disarm: () => { armed = false } }
}

describe('dkg-round4-marker-order.spec: stale marker deleted before the fresh share is stored', function () {
  this.timeout(180000)

  it('M-1/M-2: a failure at the marker delete leaves NO fresh share; the retry stores it with the producing attempt, and it survives the sweep', async () => {
    const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
    const db = auth.ctx.db
    await runDkgToQuiescence(participants, electionId, {
      stopWhen: async () => (await countRows(db, electionId, revision, 1, 3)) === participants.length
    })
    const p = await awaitingRound4(db, electionId, revision, participants)

    const shareAlias = keyholderDkgShareAlias(electionId, revision, p.userId)
    const markerAlias = keyholderDkgShareAttemptAlias(electionId, revision, p.userId)
    // A stale marker from an earlier (aborted) attempt is already present.
    await p.vault.putSecret(markerAlias, new TextEncoder().encode('9'), KEYHOLDER_SHARE_ATTEMPT_POLICY)

    const flaky = flakyVault(p.vault, markerAlias)
    const flakyEngine = new KeyholderDkgEngine(auth.ctx, { vault: flaky.vault })
    let caught: unknown
    try {
      await flakyEngine.advanceDkg(electionId, p.signer)
    } catch (err) {
      caught = err
    }
    expect(caught, 'the simulated marker-delete failure surfaces').to.not.equal(undefined)
    // WR-R2-10: the refusal must be the INJECTED crash, not some other failure on the way.
    expect(String(caught)).to.include('simulated crash at marker delete')
    expect(await p.vault.hasSecret(shareAlias), 'no fresh share exists next to the stale marker').to.equal(false)

    flaky.disarm()
    await runDkgToQuiescence(participants, electionId)
    expect(await p.vault.hasSecret(shareAlias), 'retried round 4 stored the share').to.equal(true)
    const marker = await p.vault.getSecret(markerAlias)
    expect(new TextDecoder().decode(marker!)).to.equal('1')
    for (const q of participants) {
      expect(await q.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, q.userId)), `${q.name} share survives the sweep`).to.equal(true)
    }
    const status = await p.engine.getDkgStatus(electionId, p.userId)
    expect(status.phase).to.equal('complete')
  })

  it('M-4 (WR-R2-10): a stale marker naming a genuinely ABORTED attempt: the retried share survives the V-1 sweep, and the old-order crash state would lose it', async () => {
    const { auth, electionEngine, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol', 'Dave'], threshold: 2 })
    const db = auth.ctx.db
    const revoked = participants[3]!
    const roster = participants.slice(0, 3)
    // Attempt 1 aborts for real (roster-changed, as dkg.spec H): a revoke after every R1 exists.
    await runDkgToQuiescence(participants, electionId, {
      stopWhen: async () => (await countRows(db, electionId, revision, 1, 1)) === participants.length
    })
    await electionEngine.revokeKeyholder({ name: revoked.name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }, electionId)
    await runDkgToQuiescence(roster, electionId, {
      stopWhen: async () => (await countRows(db, electionId, revision, 2, 3)) === roster.length
    })
    const status = await roster[0]!.engine.getDkgStatus(electionId)
    expect(status.attempts.find((a) => a.attempt === 1)?.outcome, 'attempt 1 is aborted (precondition, read back)').to.equal('aborted')

    const p = await awaitingRound4(db, electionId, revision, roster, 2)
    const shareAlias = keyholderDkgShareAlias(electionId, revision, p.userId)
    const markerAlias = keyholderDkgShareAttemptAlias(electionId, revision, p.userId)
    // The stale marker names attempt 1, which IS aborted: exactly what the V-1 sweep deletes on.
    await p.vault.putSecret(markerAlias, new TextEncoder().encode('1'), KEYHOLDER_SHARE_ATTEMPT_POLICY)

    const flaky = flakyVault(p.vault, markerAlias)
    let caught: unknown
    try {
      await new KeyholderDkgEngine(auth.ctx, { vault: flaky.vault }).advanceDkg(electionId, p.signer)
    } catch (err) {
      caught = err
    }
    expect(String(caught)).to.include('simulated crash at marker delete')
    expect(await p.vault.hasSecret(shareAlias), 'no fresh share next to the aborted-attempt marker').to.equal(false)

    flaky.disarm()
    await p.engine.advanceDkg(electionId, p.signer)
    expect(await p.vault.hasSecret(shareAlias), 'the retried round 4 stored the share').to.equal(true)
    expect(new TextDecoder().decode((await p.vault.getSecret(markerAlias))!)).to.equal('2')

    // The sweep can only delete while no ElectionKey exists: read that precondition back.
    const noKey = async (): Promise<boolean> => (await db.prepare('select 1 as x from ElectionKey where ElectionId = :electionId').get({ electionId })) === undefined
    expect(await noKey(), 'no ElectionKey yet, so the V-1 sweep is armed').to.equal(true)
    await p.engine.advanceDkg(electionId, p.signer) // runs cleanupVault
    expect(await p.vault.hasSecret(shareAlias), 'the share produced by attempt 2 survives the sweep').to.equal(true)

    // Negative control: the OLD order's crash state (fresh share, marker still naming aborted
    // attempt 1) is swept, so the leg above would fail under a reverted ordering.
    await p.vault.deleteSecret(markerAlias)
    await p.vault.putSecret(markerAlias, new TextEncoder().encode('1'), KEYHOLDER_SHARE_ATTEMPT_POLICY)
    expect(await noKey(), 'still no ElectionKey for the control').to.equal(true)
    await p.engine.advanceDkg(electionId, p.signer)
    expect(await p.vault.hasSecret(shareAlias), 'old-order crash state: the sweep deletes the fresh share').to.equal(false)
  })

  it('M-3: the happy path (no stale marker) still stores share + marker', async () => {
    const { electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
    await runDkgToQuiescence(participants, electionId)
    for (const q of participants) {
      expect(await q.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, q.userId))).to.equal(true)
      const m = await q.vault.getSecret(keyholderDkgShareAttemptAlias(electionId, revision, q.userId))
      expect(new TextDecoder().decode(m!)).to.equal('1')
    }
  })
})
