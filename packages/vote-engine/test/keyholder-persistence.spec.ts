/**
 * keyholder-persistence.spec.ts
 *
 * D-04 acceptance spec (39-02, DEBT-10 hard predecessor) — proves BOTH
 * previously-open gaps are closed:
 *
 *   Gap 1 — `ElectionsEngine.createElection()`'s ElectionRevision INSERT now
 *   persists `revision.keyholders` (instead of silently dropping the array).
 *   Gap 2 — the revision read-projections (`getElectionDetails`,
 *   `getRevisions`) now read the persisted keyholders back instead of
 *   hardcoding `keyholders: []`.
 *
 * Mirrors `elections-signing-seam.spec.ts` Test C's real-seam pattern
 * (seedElectionSigning -> seedElectionRevisionSigning -> createElection ->
 * getElectionDetails) rather than the `addTestElection` fixture, because
 * `addTestElection` hand-inserts its ElectionRevision row directly (bypassing
 * `createElection`'s Gap-1 fix entirely) and so cannot exercise this fix.
 *
 * RED-FIRST ORDERING (per plan Task 3): this spec was authored against the
 * ALREADY-LANDED Task 1/2 fixes in the same execution session. To confirm it
 * is not a test-after tautology, the two engine changes were manually
 * reverted (`elections-engine.ts`'s Keyholders bind removed from the
 * ElectionRevision INSERT, and `election-engine.ts`'s `getElectionDetails` /
 * `getRevisions` reverted to hardcoded `keyholders: []`) and this spec was
 * re-run:
 *
 *   RED (fix reverted):  "getElectionDetails returns non-empty keyholders
 *   after a create that supplied keyholders" FAILED —
 *   `expected [] to have a length above 0` (both `current.keyholders` and
 *   the `getRevisions()` read came back empty, confirming the assertion is
 *   load-bearing on the fix, not vacuously true).
 *
 *   GREEN (fix restored): same spec PASSED — `current.keyholders.length`
 *   and `revisions[0].keyholders.length` are both `1`, with the persisted
 *   name round-tripping byte-for-byte.
 *
 * This transition was observed directly in this session (fix reverted via a
 * temporary local edit, suite re-run, fix restored, suite re-run) — the spec
 * is genuinely red-then-green, not a tautology written against fixed code.
 */

import { UserKeyType } from '@votetorrent/vote-core'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeElectionInit,
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// Re-export the type for cast below (no import needed — TypeScript sees it via the cast),
// mirroring elections-signing-seam.spec.ts's SeedRevisionSeam shape.
type SeedRevisionSeam = {
  seedElectionRevisionSigning(
    electionId: string,
    authorityId: string,
    revision: {
      revision: number
      revisionTimestamp: number
      tags: string[]
      instructions: string
      timeline: Record<string, number>
      keyholderThreshold: number
    },
    tid: number,
    sign: (digest: Uint8Array) => Promise<Signature>,
  ): Promise<string>
}

/** Build a sign callback from a key pair for use in test cases (mirrors elections-signing-seam.spec.ts). */
function makeSignCallback (privateHex: string, userId: string, signerKey: string) {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: userId,
    signerKey,
    signature: bytesToHex(secp256k1.sign(digest, privBytes)),
  })
}

/** A name-only keyholder invitee, shaped like CreateElectionScreen.tsx's payload (blank invite placeholders). */
function makeKeyholderInvite (name: string): KeyholderInvite {
  return {
    name,
    type: 'k',
    expiration: '0',
    inviteKey: '',
    inviteSignature: '',
  }
}

describe('D-04: keyholder persistence (39-02, DEBT-10 hard predecessor)', () => {
  it('getElectionDetails and getRevisions return non-empty keyholders after a create that supplied keyholders', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()

    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: UserKeyType.mobile,
            expiration: Date.now() + 86_400_000,
          },
        ],
      },
    })
    const auth = await addTestAuthority(net)
    const electionsEngine = new ElectionsEngine(auth.ctx)

    const keyholderNames = ['Alice Keyholder']
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.keyholders = keyholderNames.map(makeKeyholderInvite)
    const { election: e } = init

    // Use a PAST revisionTimestamp so RevisionTimestampValid passes (mirrors Test C).
    const pastRevTimestamp = Date.now() - 1000

    // Step 1: sign the Election row.
    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }
    const sign = makeSignCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

    // Step 2: sign the ElectionRevision row. The seam's signed Digest deliberately
    // does NOT include keyholders (A1) — only the revision fields shared with the
    // pre-existing seam signature.
    const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
    const revisionSigningNonce = await (electionsEngine as unknown as SeedRevisionSeam).seedElectionRevisionSigning(
      e.id,
      e.authorityId,
      {
        revision: 0,
        revisionTimestamp: pastRevTimestamp,
        tags: init.revision.tags,
        instructions: init.revision.instructions,
        timeline: init.revision.timeline as Record<string, number>,
        keyholderThreshold: init.revision.keyholderThreshold,
      },
      revTid,
      sign
    )

    // Step 3: create the election (Election row + ElectionRevision Revision=0,
    // including the Gap 1 fix — the ElectionRevision INSERT now binds
    // JSON.stringify(revision.keyholders)).
    const initWithPastTs = {
      ...init,
      revision: { ...init.revision, revisionTimestamp: pastRevTimestamp },
    }
    await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })

    // Step 4 (Gap 2 assertion a): getElectionDetails returns non-empty, round-tripped keyholders.
    const electionEngine = await electionsEngine.openElection(e.id)
    const details = await electionEngine.getElectionDetails()
    expect(details.current.keyholders, 'getElectionDetails().current.keyholders').to.be.an('array').with.length(1)
    expect(details.current.keyholders[0]!.invite.name, 'persisted keyholder name round-trips').to.equal(keyholderNames[0])

    // Step 4 (Gap 2 assertion b): a getRevisions() read also returns the non-empty keyholders.
    // getRevisions() is a class-only helper (not on IElectionEngine), so construct
    // the concrete ElectionEngine directly — mirrors elections.spec.ts's getRevisions
    // describe block.
    const revisionsEngine = new ElectionEngine({ id: e.id, authorityId: e.authorityId }, auth.ctx)
    const revisions = await revisionsEngine.getRevisions()
    expect(revisions, 'getRevisions()').to.be.an('array').with.length(1)
    expect(revisions[0]!.keyholders, 'getRevisions()[0].keyholders').to.be.an('array').with.length(1)
    expect(revisions[0]!.keyholders[0]!.invite.name, 'getRevisions() persisted keyholder name round-trips').to.equal(keyholderNames[0])
  })

  it('control: an empty-keyholders create yields an empty (not error) keyholders set', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()

    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: UserKeyType.mobile,
            expiration: Date.now() + 86_400_000,
          },
        ],
      },
    })
    const auth = await addTestAuthority(net)
    const electionsEngine = new ElectionsEngine(auth.ctx)

    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.keyholders = []
    const { election: e } = init
    const pastRevTimestamp = Date.now() - 1000

    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }
    const sign = makeSignCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

    const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
    const revisionSigningNonce = await (electionsEngine as unknown as SeedRevisionSeam).seedElectionRevisionSigning(
      e.id,
      e.authorityId,
      {
        revision: 0,
        revisionTimestamp: pastRevTimestamp,
        tags: init.revision.tags,
        instructions: init.revision.instructions,
        timeline: init.revision.timeline as Record<string, number>,
        keyholderThreshold: init.revision.keyholderThreshold,
      },
      revTid,
      sign
    )

    const initWithPastTs = {
      ...init,
      revision: { ...init.revision, revisionTimestamp: pastRevTimestamp },
    }
    // Must not throw — an empty keyholders array is a valid, legitimate create.
    await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })

    const electionEngine = await electionsEngine.openElection(e.id)
    const details = await electionEngine.getElectionDetails()
    expect(details.current.keyholders, 'empty-keyholders create -> empty (not error) set').to.deep.equal([])
  })
})
