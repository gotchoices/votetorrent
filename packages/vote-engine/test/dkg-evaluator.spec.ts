/**
 * dkg-evaluator.spec.ts — 62-17 Task 1.
 *
 * Pure evaluator and planner cases (D-14, D-16, D-19, D-26). Builds
 * in-memory `DkgMessageRow` transcripts with 62-05's REAL `@noble/curves`
 * FROST primitives (`dkgRound1`/`dkgRound2`/`encryptShare`/`dkgRound3`/
 * `buildComplaintEvidence`), so every fault/verdict case is a genuine
 * cryptographic failure, not a stubbed one. No DB — `evaluateDkgRevision`
 * takes `signatureValid` as a pre-computed field on each row (SQL-side
 * verification is the engine's job, Task 2), so this spec never signs
 * anything.
 */

import { expect } from 'chai'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import {
  decryptShare,
  deriveGroupCommitments,
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  encryptShare,
  generateDkgReceivingKey,
  type ComplaintEvidence,
  type DkgContext,
  type DkgReceivedShare,
  type DkgRound1Secret,
  type DkgRound1Wire,
  type EncryptedShare
} from '../src/crypto/dkg.js'
import {
  serializeRound0Payload,
  serializeRound1Payload,
  serializeRound2Payload,
  serializeRound3Payload,
  serializeRound4Payload
} from '../src/keyholder/dkg-payloads.js'
import {
  evaluateDkgRevision,
  planDkgAction,
  resolveRoundOpenedAt,
  type DkgMessageRow,
  type DkgRevisionSnapshot
} from '../src/keyholder/dkg-evaluator.js'
import type { DkgRound } from '@votetorrent/vote-core'

const Fn = secp256k1_FROST.utils.Fn

// ---------------------------------------------------------------------------
// Simulation builder — a full honest n-party DKG over 62-05's real primitives
// ---------------------------------------------------------------------------

interface SimUser {
  userId: string
  identifier: string
  recvPrivate: Uint8Array
  recvPublic: string
  r1Public: DkgRound1Wire
  r1Secret: DkgRound1Secret
}

interface SimDkg {
  ctx: DkgContext
  threshold: number
  userIds: string[]
  usersByUserId: Record<string, SimUser>
  othersByUser: Record<string, DkgRound1Wire[]>
  r0CommitByUser: Record<string, string>
  r2ByDealer: Record<string, EncryptedShare[]>
  groupPublicKey: string
  groupCommitments: string[]
}

function makeUserIds (n: number): string[] {
  return Array.from({ length: n }, (_, i) => `u-${i + 1}`)
}

function simulateHonestDkg (n: number, k: number, ctx: DkgContext): SimDkg {
  const userIds = makeUserIds(n)
  const usersByUserId: Record<string, SimUser> = {}
  for (const userId of userIds) {
    const identifier = dkgIdentifierForUser(userId)
    const recv = generateDkgReceivingKey()
    const { public: r1Public, secret: r1Secret } = dkgRound1(identifier, k, n)
    usersByUserId[userId] = { userId, identifier, recvPrivate: recv.privateKey, recvPublic: recv.publicKey, r1Public, r1Secret }
  }
  const othersByUser: Record<string, DkgRound1Wire[]> = {}
  for (const userId of userIds) {
    othersByUser[userId] = userIds.filter((u) => u !== userId).map((u) => usersByUserId[u]!.r1Public)
  }
  const r0CommitByUser: Record<string, string> = {}
  for (const userId of userIds) {
    r0CommitByUser[userId] = commitFor(ctx, usersByUserId[userId]!.r1Public)
  }
  const r2ByDealer: Record<string, EncryptedShare[]> = {}
  for (const dealer of userIds) {
    const shares = dkgRound2(usersByUserId[dealer]!.r1Secret, othersByUser[dealer]!)
    const entries: EncryptedShare[] = []
    for (const recipient of userIds) {
      if (recipient === dealer) continue
      const share = shares[usersByUserId[recipient]!.identifier]!
      entries.push(encryptShare(ctx, usersByUserId[dealer]!.identifier, usersByUserId[recipient]!.identifier, usersByUserId[recipient]!.recvPublic, share))
    }
    r2ByDealer[dealer] = entries
  }
  let groupPublicKey = ''
  let groupCommitments: string[] = []
  for (const userId of userIds) {
    const received: DkgReceivedShare[] = othersByUser[userId]!.map((pkg) => {
      const dealerUserId = userIds.find((u) => usersByUserId[u]!.identifier === pkg.identifier)!
      const enc = r2ByDealer[dealerUserId]!.find((e) => e.recipient === usersByUserId[userId]!.identifier)!
      return { dealer: pkg.identifier, share: decryptShare(ctx, enc, usersByUserId[userId]!.recvPrivate) }
    })
    const material = dkgRound3(usersByUserId[userId]!.r1Secret, othersByUser[userId]!, received)
    groupPublicKey = material.groupPublicKey
    groupCommitments = material.groupCommitments
  }
  return { ctx, threshold: k, userIds, usersByUserId, othersByUser, r0CommitByUser, r2ByDealer, groupPublicKey, groupCommitments }
}

function commitFor (ctx: DkgContext, pkg: DkgRound1Wire): string {
  // mirrors commitRound1(ctx, pkg) — imported indirectly via dkg.ts in the real engine;
  // here we just call it directly for each user's own package.
  return commitRound1Local(ctx, pkg)
}

// re-import the real commitRound1 (kept as a named local for readability above)
import { commitRound1 as commitRound1Local } from '../src/crypto/dkg.js'

function mkRow (attempt: number, round: DkgRound, senderUserId: string, payload: string, resultKey: string | null = null, signatureValid = true): DkgMessageRow {
  return { attempt, round, senderUserId, payload, resultKey, signatureValid }
}

function round0Row (sim: SimDkg, attempt: number, senderUserId: string, rosterOverride?: string[]): DkgMessageRow {
  const roster = rosterOverride ?? [...sim.userIds].sort()
  return mkRow(attempt, 0, senderUserId, serializeRound0Payload({ v: 1, commit: sim.r0CommitByUser[senderUserId]!, roster, threshold: sim.threshold }))
}

function round1Row (sim: SimDkg, attempt: number, senderUserId: string): DkgMessageRow {
  return mkRow(attempt, 1, senderUserId, serializeRound1Payload(sim.usersByUserId[senderUserId]!.r1Public))
}

function round2Row (sim: SimDkg, attempt: number, senderUserId: string, entriesOverride?: EncryptedShare[]): DkgMessageRow {
  const entries = entriesOverride ?? sim.r2ByDealer[senderUserId]!
  return mkRow(attempt, 2, senderUserId, serializeRound2Payload(entries))
}

function ackRow (attempt: number, senderUserId: string): DkgMessageRow {
  return mkRow(attempt, 3, senderUserId, serializeRound3Payload({ v: 1, kind: 'ack' }))
}

function complaintRow (attempt: number, senderUserId: string, evidence: ComplaintEvidence[]): DkgMessageRow {
  return mkRow(attempt, 3, senderUserId, serializeRound3Payload({ v: 1, kind: 'complaint', evidence }))
}

function round4Row (sim: SimDkg, attempt: number, senderUserId: string, resultKeyOverride?: string, commitmentsOverride?: string[]): DkgMessageRow {
  const resultKey = resultKeyOverride ?? sim.groupPublicKey
  const groupCommitments = commitmentsOverride ?? sim.groupCommitments
  return mkRow(attempt, 4, senderUserId, serializeRound4Payload({ groupPublicKey: resultKey, groupCommitments }), resultKey)
}

function honestRows (sim: SimDkg, attempt: number, opts?: { uptoRound?: DkgRound }): DkgMessageRow[] {
  const upto = opts?.uptoRound ?? 4
  const rows: DkgMessageRow[] = []
  for (const u of sim.userIds) rows.push(round0Row(sim, attempt, u))
  if (upto < 1) return rows
  for (const u of sim.userIds) rows.push(round1Row(sim, attempt, u))
  if (upto < 2) return rows
  for (const u of sim.userIds) rows.push(round2Row(sim, attempt, u))
  if (upto < 3) return rows
  for (const u of sim.userIds) rows.push(ackRow(attempt, u))
  if (upto < 4) return rows
  for (const u of sim.userIds) rows.push(round4Row(sim, attempt, u))
  return rows
}

function mkSnapshot (sim: SimDkg, messages: DkgMessageRow[], overrides: Partial<DkgRevisionSnapshot> = {}): DkgRevisionSnapshot {
  const bindings: Record<string, { dkgPublicKey: string }> = {}
  for (const u of sim.userIds) bindings[u] = { dkgPublicKey: sim.usersByUserId[u]!.recvPublic }
  return {
    electionId: sim.ctx.electionId,
    revision: sim.ctx.revision,
    threshold: sim.threshold,
    liveRoster: [...sim.userIds],
    bindings,
    pendingInviteCount: 0,
    messages,
    electionKey: null,
    ...overrides
  }
}

function perturbedShareEntry (sim: SimDkg, dealer: string, recipient: string): EncryptedShare {
  const honest = sim.r2ByDealer[dealer]!.find((e) => e.recipient === sim.usersByUserId[recipient]!.identifier)!
  const share = decryptShare(sim.ctx, honest, sim.usersByUserId[recipient]!.recvPrivate)
  const badScalar = Fn.add(Fn.fromBytes(share), 1n)
  const badShare = Fn.toBytes(badScalar)
  return encryptShare(sim.ctx, sim.usersByUserId[dealer]!.identifier, sim.usersByUserId[recipient]!.identifier, sim.usersByUserId[recipient]!.recvPublic, badShare)
}

function withReplacedEntry (entries: EncryptedShare[], recipient: string, replacement: EncryptedShare): EncryptedShare[] {
  return entries.map((e) => (e.recipient === recipient ? replacement : e))
}

// ===========================================================================
// Gates
// ===========================================================================

describe('dkg-evaluator: gates', () => {
  it('an empty roster gives blocked/no-keyholders', () => {
    const ev = evaluateDkgRevision({
      electionId: 'e', revision: 0, threshold: 2, liveRoster: [], bindings: {}, pendingInviteCount: 0, messages: [], electionKey: null
    })
    expect(ev.phase).to.equal('blocked')
    expect(ev.blockedReason).to.equal('no-keyholders')
  })

  it('roster 3 with KeyholderThreshold 1 gives blocked/threshold-out-of-range', () => {
    const bindings: Record<string, { dkgPublicKey: string }> = { a: { dkgPublicKey: '02'.padEnd(66, '0') }, b: { dkgPublicKey: '02'.padEnd(66, '1') }, c: { dkgPublicKey: '02'.padEnd(66, '2') } }
    const ev = evaluateDkgRevision({
      electionId: 'e', revision: 0, threshold: 1, liveRoster: ['a', 'b', 'c'], bindings, pendingInviteCount: 0, messages: [], electionKey: null
    })
    expect(ev.phase).to.equal('blocked')
    expect(ev.blockedReason).to.equal('threshold-out-of-range')
  })

  it('k=4 with n=3 gives blocked/threshold-out-of-range', () => {
    const bindings: Record<string, { dkgPublicKey: string }> = { a: { dkgPublicKey: '02'.padEnd(66, '0') }, b: { dkgPublicKey: '02'.padEnd(66, '1') }, c: { dkgPublicKey: '02'.padEnd(66, '2') } }
    const ev = evaluateDkgRevision({
      electionId: 'e', revision: 0, threshold: 4, liveRoster: ['a', 'b', 'c'], bindings, pendingInviteCount: 0, messages: [], electionKey: null
    })
    expect(ev.phase).to.equal('blocked')
    expect(ev.blockedReason).to.equal('threshold-out-of-range')
  })

  it('pendingInviteCount 1 gives blocked/pending-invites', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, [], { pendingInviteCount: 1 }))
    expect(ev.phase).to.equal('blocked')
    expect(ev.blockedReason).to.equal('pending-invites')
  })

  it('gates passing with zero rows gives not-started, and planDkgAction returns post-round-0 for attempt 1 for every roster member', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, []))
    expect(ev.phase).to.equal('not-started')
    for (const u of sim.userIds) {
      expect(planDkgAction(ev, u)).to.deep.equal({ kind: 'post-round', attempt: 1, round: 0 })
    }
  })
})

// ===========================================================================
// Commit-reveal ordering (D-19)
// ===========================================================================

describe('dkg-evaluator: commit-reveal ordering (D-19)', () => {
  it('with 4 of 5 R0 rows present, planDkgAction returns none for posted members and never post-round-1; awaitingUserIds is the missing member', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const posted = sim.userIds.slice(0, 4)
    const missing = sim.userIds[4]!
    const rows = posted.map((u) => round0Row(sim, 1, u))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.awaitingUserIds).to.deep.equal([missing])
    for (const u of posted) {
      expect(planDkgAction(ev, u)).to.deep.equal({ kind: 'none' })
    }
    expect(planDkgAction(ev, missing)).to.deep.equal({ kind: 'post-round', attempt: 1, round: 0 })
  })
})

// ===========================================================================
// Honest transcript
// ===========================================================================

describe('dkg-evaluator: honest 3-of-5 transcript', () => {
  it('agrees, and readyToPublish carries the derived jointPublicKey/threshold/participants/roster', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1)))
    expect(ev.readyToPublish).to.not.equal(null)
    expect(ev.readyToPublish!.jointPublicKey).to.equal(deriveGroupCommitments(sim.userIds.map((u) => sim.usersByUserId[u]!.r1Public))[0])
    expect(ev.readyToPublish!.threshold).to.equal(3)
    expect(ev.readyToPublish!.participants).to.equal(5)
    expect(ev.readyToPublish!.roster).to.deep.equal([...sim.userIds].sort())
  })
})

// ===========================================================================
// Round-1 faults
// ===========================================================================

describe('dkg-evaluator: round-1 faults', () => {
  it('an R1 that differs from its R0 commit gives aborted/faults with commit-mismatch on that sender', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const wrongCommit = commitRound1Local(sim.ctx, sim.usersByUserId[sim.userIds[1]!]!.r1Public)
    const rows = [
      // R0's commit does not hash the pkg bad actually posts at round 1 —
      // the pkg itself stays fully VALID (own identifier, own PoK), so only
      // the commit-reveal check fires, isolating commit-mismatch from
      // invalid-round1.
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 0, u, serializeRound0Payload({ v: 1, commit: wrongCommit, roster: [...sim.userIds].sort(), threshold: sim.threshold })) : round0Row(sim, 1, u))),
      ...sim.userIds.map((u) => round1Row(sim, 1, u))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts[0]!.outcome).to.equal('aborted')
    expect(ev.attempts[0]!.abortReason).to.equal('faults')
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('commit-mismatch')
  })

  it('a tampered proof of knowledge gives invalid-round1', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const tampered: DkgRound1Wire = { ...sim.usersByUserId[bad]!.r1Public, proofOfKnowledge: bytesToHex(randomBytes(65)) }
    const rows = [
      // the R0 commit must still hash to the ORIGINAL package, so commitFor
      // uses the original pkg, but round1 posts the TAMPERED one — commit
      // mismatch would also fire, so instead tamper only the PoK's bytes
      // while keeping identifier/commitment (and therefore the commit hash)
      // intact: rebuild the commit for the tampered package specifically to
      // isolate the invalid-round1 case from commit-mismatch.
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 0, u, serializeRound0Payload({ v: 1, commit: commitRound1Local(sim.ctx, tampered), roster: [...sim.userIds].sort(), threshold: sim.threshold })) : round0Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 1, u, serializeRound1Payload(tampered)) : round1Row(sim, 1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts[0]!.abortReason).to.equal('faults')
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('invalid-round1')
  })

  it('an R1 whose identifier is not dkgIdentifierForUser(sender) gives invalid-round1', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const other = sim.userIds[1]!
    const wrongIdentifier: DkgRound1Wire = { ...sim.usersByUserId[bad]!.r1Public, identifier: sim.usersByUserId[other]!.identifier }
    const rows = [
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 0, u, serializeRound0Payload({ v: 1, commit: commitRound1Local(sim.ctx, wrongIdentifier), roster: [...sim.userIds].sort(), threshold: sim.threshold })) : round0Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 1, u, serializeRound1Payload(wrongIdentifier)) : round1Row(sim, 1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('invalid-round1')
  })

  it('an R1 whose commitment length is not k gives invalid-round1', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const shortCommitment: DkgRound1Wire = { ...sim.usersByUserId[bad]!.r1Public, commitment: [sim.usersByUserId[bad]!.r1Public.commitment[0]!] }
    const rows = [
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 0, u, serializeRound0Payload({ v: 1, commit: commitRound1Local(sim.ctx, shortCommitment), roster: [...sim.userIds].sort(), threshold: sim.threshold })) : round0Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === bad ? mkRow(1, 1, u, serializeRound1Payload(shortCommitment)) : round1Row(sim, 1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('invalid-round1')
  })
})

// ===========================================================================
// Round-2 fault
// ===========================================================================

describe('dkg-evaluator: round-2 fault (malformed-round2)', () => {
  it('an R2 missing one recipient gives malformed-round2', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const entries = sim.r2ByDealer[bad]!.slice(1)
    const rows = [...honestRows(sim, 1, { uptoRound: 1 }), ...sim.userIds.map((u) => (u === bad ? round2Row(sim, 1, u, entries) : round2Row(sim, 1, u)))]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('malformed-round2')
  })

  it('an R2 that duplicates a recipient gives malformed-round2', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const entries = [sim.r2ByDealer[bad]![0]!, sim.r2ByDealer[bad]![0]!]
    const rows = [...honestRows(sim, 1, { uptoRound: 1 }), ...sim.userIds.map((u) => (u === bad ? round2Row(sim, 1, u, entries) : round2Row(sim, 1, u)))]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('malformed-round2')
  })

  it('an R2 whose dealer is not the sender gives malformed-round2', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const other = sim.userIds[1]!
    const entries = sim.r2ByDealer[other]!
    const rows = [...honestRows(sim, 1, { uptoRound: 1 }), ...sim.userIds.map((u) => (u === bad ? round2Row(sim, 1, u, entries) : round2Row(sim, 1, u)))]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('malformed-round2')
  })
})

// ===========================================================================
// Round-3 verdicts (D-19)
// ===========================================================================

describe('dkg-evaluator: round-3 verdicts', () => {
  it('a perturbed share plus the recipient\'s genuine complaint gives the dealer invalid-share', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const badEntry = perturbedShareEntry(sim, dealer, recipient)
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, badEntry)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(badEntry.ephemeralPublicKey).toBytes(true), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, 1, u, dealerEntries) : round2Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts[0]!.abortReason).to.equal('faults')
    const d = ev.disqualified.find((x) => x.userId === dealer)
    expect(d?.reason).to.equal('invalid-share')
    expect(d?.complainantUserId).to.equal(recipient)
  })

  it('random-bytes ciphertext gives the dealer undecryptable-share', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const honest = sim.r2ByDealer[dealer]!.find((e) => e.recipient === sim.usersByUserId[recipient]!.identifier)!
    const garbled: EncryptedShare = { ...honest, ciphertext: bytesToHex(randomBytes(32 + 16)) }
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, garbled)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(honest.ephemeralPublicKey).toBytes(true), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, 1, u, dealerEntries) : round2Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((x) => x.userId === dealer)?.reason).to.equal('undecryptable-share')
  })

  it('a genuine-evidence complaint against an honest dealer gives the complainant false-complaint', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const honest = sim.r2ByDealer[dealer]!.find((e) => e.recipient === sim.usersByUserId[recipient]!.identifier)!
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(honest.ephemeralPublicKey).toBytes(true), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 2 }),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((x) => x.userId === recipient)?.reason).to.equal('false-complaint')
  })

  it('a complaint whose recipient is not the complainant\'s identifier gives malformed-complaint', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const other = sim.userIds[2]!
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[other]!.identifier, sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 2 }),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((x) => x.userId === recipient)?.reason).to.equal('malformed-complaint')
  })

  it('a random-point sharedSecret gives aborted/unresolved-complaint with an empty disqualified list and unresolvedComplaints 1', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 2 }),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts[0]!.outcome).to.equal('aborted')
    expect(ev.attempts[0]!.abortReason).to.equal('unresolved-complaint')
    expect(ev.attempts[0]!.disqualified).to.deep.equal([])
    expect(ev.attempts[0]!.unresolvedComplaints).to.equal(1)
  })
})

// ===========================================================================
// Boundary determinism
// ===========================================================================

describe('dkg-evaluator: boundary determinism', () => {
  it('with one complaint present and another member\'s R3 missing, the attempt is still collecting and awaitingUserIds lists the missing member', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const missing = sim.userIds[2]!
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 2 }),
      complaintRow(1, recipient, evidence),
      ackRow(1, dealer)
      // `missing` posts no R3 row at all.
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts).to.deep.equal([])
    expect(ev.currentRound).to.equal(3)
    expect(ev.awaitingUserIds).to.deep.equal([missing])
  })

  it('two complaints against two different dealers in one attempt disqualify both in a single abort', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const [d1, d2, x1, x2] = sim.userIds
    const evidence1 = [{ dealer: sim.usersByUserId[d1!]!.identifier, recipient: sim.usersByUserId[x1!]!.identifier, sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)) }]
    const evidence2Honest = sim.r2ByDealer[d2!]!.find((e) => e.recipient === sim.usersByUserId[x2!]!.identifier)!
    const evidence2 = [{ dealer: sim.usersByUserId[d2!]!.identifier, recipient: sim.usersByUserId[x2!]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[x2!]!.recvPrivate, secp256k1.Point.fromHex(evidence2Honest.ephemeralPublicKey).toBytes(true), true)) }]
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 2 }),
      ...sim.userIds.map((u) => {
        if (u === x1) return complaintRow(1, u, evidence1)
        if (u === x2) return complaintRow(1, u, evidence2)
        return ackRow(1, u)
      })
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts.length).to.equal(1)
    expect(ev.attempts[0]!.abortReason).to.equal('faults')
    const disqualifiedUsers = ev.disqualified.map((d) => d.userId).sort()
    // d1 is unresolved (random-point) -> not disqualified; d2 is a real
    // genuine complaint against an HONEST dealer -> the COMPLAINANT x2 is
    // disqualified (false-complaint). So the single-abort disqualified set
    // is exactly [x2].
    expect(disqualifiedUsers).to.deep.equal([x2].sort())
  })
})

// ===========================================================================
// Round 4
// ===========================================================================

describe('dkg-evaluator: round-4 mismatch', () => {
  it('an R4 whose ResultKey differs from the derived value gives round4-mismatch on that sender', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bad = sim.userIds[0]!
    const wrongKey = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const rows = [
      ...honestRows(sim, 1, { uptoRound: 3 }),
      ...sim.userIds.map((u) => (u === bad ? round4Row(sim, 1, u, wrongKey, [wrongKey, ...sim.groupCommitments.slice(1)]) : round4Row(sim, 1, u)))
    ]
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.disqualified.find((d) => d.userId === bad)?.reason).to.equal('round4-mismatch')
  })
})

// ===========================================================================
// Restart and cap
// ===========================================================================

describe('dkg-evaluator: restart and cap', () => {
  function badDealerAttempt (sim: SimDkg, attempt: number, dealer: string, recipient: string): DkgMessageRow[] {
    const badEntry = perturbedShareEntry(sim, dealer, recipient)
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, badEntry)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(badEntry.ephemeralPublicKey).toBytes(true), true)) }]
    return [
      ...honestRows(sim, attempt, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, attempt, u, dealerEntries) : round2Row(sim, attempt, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(attempt, u, evidence) : ackRow(attempt, u)))
    ]
  }

  it('after attempt 1 aborts with dealer D disqualified, while D is still in the live roster, planDkgAction for any honest member returns remove-disqualified [D] before any post', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const honest = sim.userIds[2]!
    const rows = badDealerAttempt(sim, 1, dealer, recipient)
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.cumulativeDisqualified).to.deep.equal([dealer])
    expect(planDkgAction(ev, honest)).to.deep.equal({ kind: 'remove-disqualified', userIds: [dealer] })
  })

  it('once D is out of the roster it returns post-round-0 for attempt 2', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const honest = sim.userIds[2]!
    const rows = badDealerAttempt(sim, 1, dealer, recipient)
    const liveAfterRemoval = sim.userIds.filter((u) => u !== dealer)
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows, { liveRoster: liveAfterRemoval }))
    expect(ev.phase).to.equal('restarting')
    expect(ev.currentAttempt).to.equal(2)
    expect(planDkgAction(ev, honest)).to.deep.equal({ kind: 'post-round', attempt: 2, round: 0 })
  })

  it('three aborted attempts give failed/attempts-exhausted, and planDkgAction returns none', () => {
    const userIds = makeUserIds(3)
    const dealer = userIds[0]!
    const recipient = userIds[1]!
    const honest = userIds[2]!
    const rows: DkgMessageRow[] = []
    let lastSim: SimDkg | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt })
      lastSim = sim
      const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)) }]
      rows.push(
        ...honestRows(sim, attempt, { uptoRound: 2 }),
        ...sim.userIds.map((u) => (u === recipient ? complaintRow(attempt, u, evidence) : ackRow(attempt, u)))
      )
    }
    const ev = evaluateDkgRevision(mkSnapshot(lastSim!, rows))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('attempts-exhausted')
    expect(planDkgAction(ev, honest)).to.deep.equal({ kind: 'none' })
  })

  it('3-of-3 with one dealer disqualified gives failed/threshold-unreachable', () => {
    const sim = simulateHonestDkg(3, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const rows = badDealerAttempt(sim, 1, dealer, recipient)
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('threshold-unreachable')
  })
})

// ===========================================================================
// Roster rules
// ===========================================================================

describe('dkg-evaluator: roster rules', () => {
  it('an R0 declaring a user with no visible binding gives in-progress with waitingReason roster-mismatch (no abort), naming the declaring keyholder (initial/G2 WR-02)', () => {
    // Revision 1: this case used to assert only the wait (and awaitingUserIds = []). It now also asserts WHO is named,
    // because naming the declarer is the fix: the AR-62-053 revoke remedy needs someone to point at.
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const ghostRoster = [...sorted, 'zzz-ghost'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i === 0 ? ghostRoster : sorted))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.phase).to.equal('in-progress')
    expect(ev.waitingReason).to.equal('roster-mismatch')
    expect(ev.attempts).to.deep.equal([])
    expect(ev.disqualified).to.deep.equal([])
    expect(ev.awaitingUserIds).to.deep.equal([sim.userIds[0]])
  })

  it('two keyholders declaring the same phantom are both named, sorted', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const ghostRoster = [...sorted, 'zzz-ghost'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i < 2 ? ghostRoster : sorted))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.waitingReason).to.equal('roster-mismatch')
    expect(ev.awaitingUserIds).to.deep.equal([sim.userIds[0], sim.userIds[1]].sort())
  })

  it('an unbound id with a visible Keyholder row (replication lag) is itself the one awaited, and its declarer is not blamed', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const lagRoster = [...sorted, 'zzz-lag'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i === 0 ? lagRoster : sorted))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows, { liveRoster: [...sim.userIds, 'zzz-lag'] }))
    expect(ev.phase).to.equal('in-progress')
    expect(ev.waitingReason).to.equal('roster-mismatch')
    expect(ev.awaitingUserIds).to.deep.equal(['zzz-lag'])
    expect(ev.disqualified).to.deep.equal([])
  })

  it('an unbound id that signed a round-0 row of its own is traced too (named itself, not its declarer)', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const lagRoster = [...sorted, 'zzz-lag'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i === 0 ? lagRoster : sorted))
    rows.push(mkRow(1, 0, 'zzz-lag', serializeRound0Payload({ v: 1, commit: sim.r0CommitByUser[sim.userIds[0]!]!, roster: lagRoster, threshold: sim.threshold })))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.waitingReason).to.equal('roster-mismatch')
    expect(ev.awaitingUserIds).to.deep.equal(['zzz-lag'])
  })

  it('lag resolution: once the binding replicates nobody is disqualified, before or after, and no snapshot plans a removal', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const lagRoster = [...sorted, 'zzz-lag'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i === 0 ? lagRoster : sorted))
    const before = mkSnapshot(sim, rows, { liveRoster: [...sim.userIds, 'zzz-lag'] })
    const after = mkSnapshot(sim, rows, { liveRoster: [...sim.userIds, 'zzz-lag'] })
    after.bindings['zzz-lag'] = { dkgPublicKey: '02'.padEnd(66, '9') }
    for (const snapshot of [before, after]) {
      const ev = evaluateDkgRevision(snapshot)
      expect(ev.disqualified).to.deep.equal([])
      expect(ev.cumulativeDisqualified).to.deep.equal([])
      for (const u of sim.userIds) expect(planDkgAction(ev, u).kind).to.not.equal('remove-disqualified')
    }
    // After replication the stall is the ordinary "waiting for zzz-lag's round-0 row", not a roster wait.
    const evAfter = evaluateDkgRevision(after)
    expect(evAfter.waitingReason).to.equal(undefined)
    expect(evAfter.awaitingUserIds).to.deep.equal(['zzz-lag'])
  })

  it('remedy: revoking the declaring keyholder clears the phantom stall and an honest attempt 2 completes', () => {
    const sim1 = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim1.userIds].sort()
    const declarer = sim1.userIds[2]!
    const ghostRoster = [...sorted, 'zzz-ghost'].sort()
    const attempt1 = sim1.userIds.map((u) => round0Row(sim1, 1, u, u === declarer ? ghostRoster : sorted))
    const stalled = evaluateDkgRevision(mkSnapshot(sim1, attempt1))
    expect(stalled.waitingReason).to.equal('roster-mismatch')
    expect(stalled.awaitingUserIds).to.deep.equal([declarer])
    for (const u of sim1.userIds) expect(planDkgAction(stalled, u).kind).to.not.equal('remove-disqualified')

    // An officer revokes the declarer (AR-62-053). The remaining two run an honest attempt 2.
    const sim2 = simulateHonestDkg(2, 2, { electionId: 'e', revision: 0, attempt: 2 })
    const snapshot = mkSnapshot(sim2, [...attempt1, ...honestRows(sim2, 2)], { liveRoster: [...sim2.userIds] })
    snapshot.bindings[declarer] = { dkgPublicKey: sim1.usersByUserId[declarer]!.recvPublic }
    const ev = evaluateDkgRevision(snapshot)
    expect(ev.attempts[0]!.outcome).to.equal('aborted')
    expect(ev.attempts[0]!.abortReason).to.equal('roster-changed')
    expect(ev.disqualified).to.deep.equal([])
    expect(ev.currentAttempt).to.equal(2)
    expect(ev.readyToPublish).to.not.equal(null)
  })

  it('an R0 declaring a user whose binding is visible but whose Keyholder row is gone gives aborted/roster-changed', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const sorted = [...sim.userIds].sort()
    const extendedRoster = [...sorted, 'z-removed'].sort()
    const rows = sim.userIds.map((u, i) => round0Row(sim, 1, u, i === 0 ? extendedRoster : sorted))
    const snapshot = mkSnapshot(sim, rows)
    snapshot.bindings['z-removed'] = { dkgPublicKey: '02'.padEnd(66, '9') }
    const ev = evaluateDkgRevision(snapshot)
    expect(ev.attempts[0]!.outcome).to.equal('aborted')
    expect(ev.attempts[0]!.abortReason).to.equal('roster-changed')
  })

  it('a live keyholder missing from every R0 roster gives aborted/roster-changed', () => {
    const sim = simulateHonestDkg(4, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const incompleteRoster = sim.userIds.filter((u) => u !== sim.userIds[3]).sort()
    const rows = sim.userIds.map((u) => round0Row(sim, 1, u, incompleteRoster))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.attempts[0]!.outcome).to.equal('aborted')
    expect(ev.attempts[0]!.abortReason).to.equal('roster-changed')
  })

  it('a stale attempt-2 R0 from a user disqualified in attempt 1 is ignored and does NOT abort attempt 2', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const badEntry = perturbedShareEntry(sim, dealer, recipient)
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, badEntry)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(badEntry.ephemeralPublicKey).toBytes(true), true)) }]
    const attempt1Rows = [
      ...honestRows(sim, 1, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, 1, u, dealerEntries) : round2Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    // D posts a stale, otherwise-valid-looking attempt-2 R0 row.
    const staleRow = round0Row(sim, 2, dealer)
    const ev = evaluateDkgRevision(mkSnapshot(sim, [...attempt1Rows, staleRow]))
    expect(ev.phase).to.not.equal('failed')
    expect(ev.currentAttempt).to.equal(2)
    expect(ev.currentRound).to.equal(0)
  })

  it('a disqualified user re-added to the live roster is planned for removal and does not abort attempt 2', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const honest = sim.userIds[2]!
    const badEntry = perturbedShareEntry(sim, dealer, recipient)
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, badEntry)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(badEntry.ephemeralPublicKey).toBytes(true), true)) }]
    const attempt1Rows = [
      ...honestRows(sim, 1, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, 1, u, dealerEntries) : round2Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ]
    // D is still (or again) present in the live roster.
    const ev = evaluateDkgRevision(mkSnapshot(sim, attempt1Rows, { liveRoster: [...sim.userIds] }))
    expect(ev.phase).to.not.equal('failed')
    expect(planDkgAction(ev, honest)).to.deep.equal({ kind: 'remove-disqualified', userIds: [dealer] })
  })
})

// ===========================================================================
// Invalid signatures
// ===========================================================================

describe('dkg-evaluator: invalid-signature rows', () => {
  it('a row with signatureValid false is treated as absent, is listed in invalidRows, and never disqualifies the claimed sender', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const target = sim.userIds[0]!
    const rows = sim.userIds.map((u) => (u === target ? { ...round0Row(sim, 1, u), signatureValid: false } : round0Row(sim, 1, u)))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.invalidRows).to.deep.equal([{ attempt: 1, round: 0, senderUserId: target }])
    expect(ev.disqualified.find((d) => d.userId === target)).to.equal(undefined)
    // the boundary is not met (target's valid row is missing), so the attempt is still collecting.
    expect(ev.awaitingUserIds).to.deep.equal([target])
  })
})

// ===========================================================================
// ElectionKey consistency
// ===========================================================================

describe('dkg-evaluator: ElectionKey consistency', () => {
  it('an ElectionKey present and consistent gives complete', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const publisher = sim.userIds[0]!
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), {
      electionKey: {
        electionId: 'e', revision: 0, attempt: 1, jointPublicKey: sim.groupPublicKey, groupCommitments: sim.groupCommitments,
        threshold: 2, participants: 3, publishedAt: '2026-01-01T00:00:00Z', publisherUserId: publisher, signatureValid: true,
        commitmentsWellFormed: true
      }
    }))
    expect(ev.phase).to.equal('complete')
  })

  it('an ElectionKey whose JointPublicKey differs from the agreed Y gives failed/election-key-mismatch', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const publisher = sim.userIds[0]!
    const wrongKey = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), {
      electionKey: {
        electionId: 'e', revision: 0, attempt: 1, jointPublicKey: wrongKey, groupCommitments: sim.groupCommitments,
        threshold: 2, participants: 3, publishedAt: '2026-01-01T00:00:00Z', publisherUserId: publisher, signatureValid: true,
        commitmentsWellFormed: true
      }
    }))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('election-key-mismatch')
  })
  // 62-34 V-2: rule 9 binds commitments, threshold and participants to the agreed round-4 result.
  function ekFor (sim: ReturnType<typeof simulateHonestDkg>, over: Record<string, unknown> = {}) {
    return {
      electionId: 'e', revision: 0, attempt: 1, jointPublicKey: sim.groupPublicKey, groupCommitments: [...sim.groupCommitments],
      threshold: 2, participants: 3, publishedAt: '2026-01-01T00:00:00Z', publisherUserId: sim.userIds[0]!, signatureValid: true,
      commitmentsWellFormed: true, ...over
    }
  }

  it('62-34: honest consistent ElectionKey (positive control) gives complete', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: ekFor(sim) }))
    expect(ev.phase).to.equal('complete')
  })

  it('62-34: commitments differing in one element give failed/election-key-mismatch', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const forged = [...sim.groupCommitments]
    forged[1] = other
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: ekFor(sim, { groupCommitments: forged }) }))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('election-key-mismatch')
  })

  it('62-34: a threshold differing from the agreed attempt gives failed/election-key-mismatch', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: ekFor(sim, { threshold: 3 }) }))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('election-key-mismatch')
  })

  it('62-34: participants differing from the agreed roster gives failed/election-key-mismatch', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: ekFor(sim, { participants: 2 }) }))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('election-key-mismatch')
  })

  it('62-34: commitmentsWellFormed false (malformed column) gives failed/election-key-mismatch', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: ekFor(sim, { groupCommitments: [], commitmentsWellFormed: false }) }))
    expect(ev.phase).to.equal('failed')
    expect(ev.failedReason).to.equal('election-key-mismatch')
  })
})

// ===========================================================================
// 62-139: round timing candidates (clock-free) and the pure resolver
// ===========================================================================

describe('dkg-evaluator: round timing candidates (62-139)', () => {
  const T = Date.parse('2026-10-01T00:00:00.000Z')
  const iso = (ms: number): string => new Date(ms).toISOString()
  /** Distinct sentAt per row (index minutes after T). */
  function stamp (rows: DkgMessageRow[], startMs = T): DkgMessageRow[] {
    return rows.map((r, i) => ({ ...r, sentAt: iso(startMs + i * 60_000) }))
  }

  it('E1: cut after round 1 complete: opening = the five round-1 (userId, sentAt) pairs, answers empty', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const rows = stamp(honestRows(sim, 1, { uptoRound: 1 }))
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows))
    expect(ev.currentRound).to.equal(2)
    const expected = rows.filter((r) => r.round === 1).map((r) => ({ userId: r.senderUserId, at: r.sentAt! }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.at < b.at ? -1 : 1))
    expect(ev.roundTiming).to.deep.equal({ opening: expected, answers: [] })
  })

  it('E2: attempt 1 round 0: opening holds only live members bindings', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const bindings: Record<string, { dkgPublicKey: string, boundAt?: string }> = {}
    sim.userIds.forEach((u, i) => { bindings[u] = { dkgPublicKey: sim.usersByUserId[u]!.recvPublic, boundAt: iso(T + i * 1000) } })
    bindings['stranger'] = { dkgPublicKey: '02'.padEnd(66, '9'), boundAt: iso(T + 99 * 3_600_000) }
    const ev = evaluateDkgRevision(mkSnapshot(sim, [], { bindings }))
    expect(ev.phase).to.equal('not-started')
    expect(ev.roundTiming!.opening.map((c) => c.userId)).to.deep.equal([...sim.userIds].sort())
    expect(ev.roundTiming!.answers).to.deep.equal([])
  })

  it('E3: attempt 2 round 0 (restarting): opening = every attempt-1 row with its sentAt', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const dealer = sim.userIds[0]!
    const recipient = sim.userIds[1]!
    const badEntry = perturbedShareEntry(sim, dealer, recipient)
    const dealerEntries = withReplacedEntry(sim.r2ByDealer[dealer]!, sim.usersByUserId[recipient]!.identifier, badEntry)
    const evidence = [{ dealer: sim.usersByUserId[dealer]!.identifier, recipient: sim.usersByUserId[recipient]!.identifier, sharedSecret: bytesToHex(secp256k1.getSharedSecret(sim.usersByUserId[recipient]!.recvPrivate, secp256k1.Point.fromHex(badEntry.ephemeralPublicKey).toBytes(true), true)) }]
    const rows = stamp([
      ...honestRows(sim, 1, { uptoRound: 1 }),
      ...sim.userIds.map((u) => (u === dealer ? round2Row(sim, 1, u, dealerEntries) : round2Row(sim, 1, u))),
      ...sim.userIds.map((u) => (u === recipient ? complaintRow(1, u, evidence) : ackRow(1, u)))
    ])
    const ev = evaluateDkgRevision(mkSnapshot(sim, rows, { liveRoster: sim.userIds.filter((u) => u !== dealer) }))
    expect(ev.phase).to.equal('restarting')
    expect(ev.roundTiming!.opening).to.have.length(rows.length)
    expect(ev.roundTiming!.answers).to.deep.equal([])
  })

  it('E4: unstamped rows are omitted', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const ev = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1, { uptoRound: 1 })))
    expect(ev.roundTiming).to.deep.equal({ opening: [], answers: [] })
  })

  it('E5: complete, failed and blocked give null timing', () => {
    const sim = simulateHonestDkg(3, 2, { electionId: 'e', revision: 0, attempt: 1 })
    const blocked = evaluateDkgRevision(mkSnapshot(sim, [], { pendingInviteCount: 1 }))
    expect(blocked.roundTiming).to.equal(null)
    const failed = evaluateDkgRevision(mkSnapshot(sim, honestRows(sim, 1), { electionKey: { electionId: 'e', revision: 0, attempt: 1, jointPublicKey: 'zz', groupCommitments: [], threshold: 2, participants: 3, publishedAt: '', publisherUserId: 'u-1', signatureValid: true, commitmentsWellFormed: true } }))
    expect(failed.phase).to.equal('failed')
    expect(failed.roundTiming).to.equal(null)
  })

  it('E6: reversing the message array gives a deep-equal roundTiming', () => {
    const sim = simulateHonestDkg(5, 3, { electionId: 'e', revision: 0, attempt: 1 })
    const rows = stamp(honestRows(sim, 1, { uptoRound: 1 }))
    const a = evaluateDkgRevision(mkSnapshot(sim, rows)).roundTiming
    const b = evaluateDkgRevision(mkSnapshot(sim, [...rows].reverse())).roundTiming
    expect(a).to.deep.equal(b)
  })

  describe('resolveRoundOpenedAt', () => {
    const skew = 5 * 60_000
    it('E7: a future-dated awaited opening row cannot move the result later; the earliest answer caps', () => {
      const timing = { opening: [{ userId: 'C', at: iso(T + 30 * 86_400_000) }], answers: [{ userId: 'B', at: iso(T + 120_000) }, { userId: 'A', at: iso(T + 60_000) }] }
      expect(resolveRoundOpenedAt(timing, ['C'], T + 3_600_000, skew)).to.equal(iso(T + 60_000))
      const usable = { ...timing, opening: [{ userId: 'C', at: iso(T + 120_000) }] }
      expect(resolveRoundOpenedAt(usable, ['C'], T + 3_600_000, skew)).to.equal(iso(T + 60_000))
    })
    it('E8: no answers: latest surviving opening; unparsable skipped; all dropped null; null timing null', () => {
      const t = { opening: [{ userId: 'a', at: iso(T) }, { userId: 'b', at: iso(T + 60_000) }, { userId: 'c', at: iso(T + 30 * 86_400_000) }, { userId: 'd', at: 'garbage' }], answers: [] }
      expect(resolveRoundOpenedAt(t, [], T + 600_000, skew)).to.equal(iso(T + 60_000))
      expect(resolveRoundOpenedAt({ opening: [{ userId: 'c', at: iso(T + 86_400_000) }], answers: [] }, [], T, skew)).to.equal(null)
      expect(resolveRoundOpenedAt(null, [], T, skew)).to.equal(null)
    })
    it('E9: a future answer is dropped; an awaited user answer is not an answer', () => {
      const t = { opening: [{ userId: 'a', at: iso(T) }], answers: [{ userId: 'b', at: iso(T + 86_400_000) }] }
      expect(resolveRoundOpenedAt(t, [], T + 60_000, skew)).to.equal(iso(T))
      const t2 = { opening: [{ userId: 'a', at: iso(T + 60_000) }], answers: [{ userId: 'c', at: iso(T) }] }
      expect(resolveRoundOpenedAt(t2, ['c'], T + 120_000, skew)).to.equal(iso(T + 60_000))
    })
    it('E10: the first answer never moves the opening later', () => {
      const t = { opening: [{ userId: 'a', at: iso(T) }], answers: [{ userId: 'b', at: iso(T + 30 * 3_600_000) }] }
      expect(resolveRoundOpenedAt(t, ['c'], T + 30 * 3_600_000 + 60_000, skew)).to.equal(iso(T))
    })
  })
})
