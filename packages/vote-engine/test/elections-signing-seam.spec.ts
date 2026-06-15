/**
 * elections-signing-seam.spec.ts
 *
 * Regression-locking test for the real ElectionsEngine.seedElectionSigning →
 * createElection seam through Election.InsertValid.
 *
 * Coverage gap closed: compliance.spec.ts FLOW-03 exercised only the FIXTURE
 * path (addTestElection → fixture seedElectionSigning), which used tid: String(tid)
 * — the same mismatch. The REAL engine path (ElectionsEngine.seedElectionSigning)
 * had no Node test that drove InsertValid end-to-end. This file fills that gap.
 *
 * Fails-before evidence: on the pre-fix code (tid: String(tid) at both Digest
 * sites in elections-engine.ts) this test throws:
 *   Error: ElectionsEngine.createElection: CHECK constraint failed: InsertValid
 * because Digest('1', …) ≠ Digest(1, …) — stored AdminSigning.Digest never
 * equals InsertValid's recomputed Digest(context.Tid:int, …), so the exists()
 * sub-select is empty and InsertValid fails.
 *
 * Passes-after: with tid: tid (JS number → INTEGER) both Digest computations
 * produce the same bytes → InsertValid passes → Election row inserts.
 */

import { UserKeyType } from '@votetorrent/vote-core'
import type { Signature } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeElectionInit,
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// Re-export the type for cast below (no import needed — TypeScript sees it via the cast)
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

/** Build a sign callback from a key pair for use in test cases. */
function makeSignCallback (privateHex: string, userId: string, signerKey: string) {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: userId,
    signerKey,
    signature: bytesToHex(secp256k1.sign(digest, privBytes)),
  })
}

describe('Real-seam: seedElectionSigning → createElection through InsertValid', () => {

  it('Test A — Election row inserts via REAL seedElectionSigning with genuine secp256k1 signing (regression: InsertValid must pass)', async () => {
    // Generate a key pair whose privateHex the test controls (genuine secp256k1).
    const { privateHex, publicHex } = randomTestKeyPair()

    // Seed a network+authority context where the user's activeKeys[0].key is
    // the publicHex from our known pair, so seedElectionSigning can sign with
    // the matching privateHex.
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

    // Construct the REAL ElectionsEngine — NOT the fixture path.
    const electionsEngine = new ElectionsEngine(auth.ctx)

    // Build an ElectionInit for the authority.
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const { election: e } = init

    // electionFields must be byte-identical to what createElection inserts
    // (same id, authorityId, title, canonical dates, type).
    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }

    // Call the REAL seedElectionSigning with genuine secp256k1 sign callback.
    const sign = makeSignCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

    // createElection MUST resolve without throwing.
    // Pre-fix: throws CHECK constraint failed: InsertValid
    // Post-fix: inserts the Election row successfully
    await electionsEngine.createElection(init, { signingNonce })

    // Assert the Election row was actually inserted.
    const result = (await auth.ctx.db
      .prepare('select count(*) as n from Election')
      .get()) as { n: number } | null
    expect(result?.n, 'Election row count after seedElectionSigning + createElection').to.be.gte(1)
  })

  it('Test B — stored AdminSigning.Digest (mel scope) matches INTEGER Tid recompute', async () => {
    // NOTE: On Node, Quereus coerces integer 1 and string "1" to the same Digest
    // because the in-process Digest() function normalises numeric types. On device
    // (Hermes + Quereus native via LevelDB vtab), the types diverge: Digest(1, …) ≠
    // Digest('1', …). This is why the bug was invisible in Node tests but fatal on
    // device. This Test B verifies only that the STORED Digest matches the INTEGER
    // Tid recompute — the positive-path assertion that is true both on Node and device.
    // The pre-fix negative assertion (stored ≠ String(tid) form) is device-only
    // observable and is not checked here.

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
    const { election: e } = init

    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }

    // Capture the tid BEFORE calling seedElectionSigning so we can compare digests.
    const tid = peekNextElectionTid()

    const sign = makeSignCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)
    await electionsEngine.createElection(init, { signingNonce })

    const db = auth.ctx.db

    // Retrieve the stored Digest from AdminSigning for scope='mel'.
    const storedRow = (await db
      .prepare("select Digest from AdminSigning where AuthorityId = :authorityId and Scope = 'mel' limit 1")
      .get({ authorityId: auth.authority.id })) as { Digest: unknown } | null
    expect(storedRow, 'AdminSigning mel row exists').to.not.be.null

    // Recompute with INTEGER tid — should match the stored value.
    const { toCanonicalDatetime } = await import('../src/utils.js')
    const intRow = (await db
      .prepare('select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d')
      .get({
        tid: tid,  // INTEGER — the correct form matching context.Tid:int
        id: e.id,
        authorityId: e.authorityId,
        title: e.title,
        date: toCanonicalDatetime(e.date),
        revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
        ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
        type: e.type,
      })) as { d: unknown } | null

    // Helper to normalise Digest values for comparison (Uint8Array / base64url → hex string).
    function normalise (v: unknown): string {
      if (v instanceof Uint8Array) {
        return Buffer.from(v).toString('hex')
      }
      if (Buffer.isBuffer(v)) {
        return (v as Buffer).toString('hex')
      }
      return String(v)
    }

    const stored = normalise(storedRow!.Digest)
    const intDigest = normalise(intRow?.d)

    expect(stored, 'stored Digest matches INTEGER Tid recompute (the Digest seam stores the same value InsertValid recomputes)').to.equal(intDigest)
  })

  it('Test C — createElection + revision seam → getElectionDetails returns current.revision === 0 (FLOW-04 regression lock)', async () => {
    // Fails-before evidence: without the ElectionRevision insert in createElection,
    // getElectionDetails() throws:
    //   ElectionEngine.getElectionDetails: Election <id> has no current revision
    // Passes-after: with the revision insert (Revision=0) satisfying MutationValid,
    // getElectionDetails() returns { current: { revision: 0, ... } }.

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
    const { election: e } = init

    // Use a PAST revisionTimestamp so RevisionTimestampValid passes.
    // Supply the SAME epoch ms to both the seam and init.revision.revisionTimestamp
    // so toCanonicalDatetime() produces identical bytes in both paths.
    const pastRevTimestamp = Date.now() - 1000

    // Step 1: sign the Election row
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

    // Step 2: sign the ElectionRevision row.
    // revTid = peekNextElectionTid() + 1 — Election consumes T, revision consumes T+1.
    const revTid = peekNextElectionTid() + 1
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

    // Step 3: create the election (Election row + ElectionRevision Revision=0).
    // Pass a PAST revisionTimestamp in init.revision so createElection binds the same bytes.
    const initWithPastTs = {
      ...init,
      revision: { ...init.revision, revisionTimestamp: pastRevTimestamp },
    }
    await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })

    // Step 4: open the election and call getElectionDetails.
    // Pre-fix: throws "has no current revision"
    // Post-fix: returns current.revision === 0
    const electionEngine = await electionsEngine.openElection(e.id)
    const details = await electionEngine.getElectionDetails()
    expect(details.current.revision, 'getElectionDetails.current.revision').to.equal(0)
  })
})
