/**
 * canonical-binding.spec.ts — Wave-0 Nyquist scaffolds for the canonical digest migration
 *
 * Provides two RED/GREEN gates that downstream waves (Plans 29-02 and 29-03) turn GREEN:
 *
 * D-06 (RED now — intentional Wave-0 gap):
 *   Asserts that `Digest('hello')` returns a NON-empty string that does NOT equal the
 *   old `|`-join SHA-256 value. Today the local `digestSchema` UDF is still active and
 *   RETURNS that old value — so the inequality assertion FAILS (RED). After Plan 29-02
 *   deletes the UDF and registers the canonical plugin, the returned value differs from
 *   the old SHA-256 and the assertion PASSES (GREEN). This verifies binding-by-behavior,
 *   not by inspecting the plugin source.
 *
 * D-11 (GREEN now — regression lock):
 *   Asserts that `context.Tid` reaches SQL as an INTEGER (not a string), so the stored
 *   AdminSigning.Digest matches the recomputed Digest using an integer tid binding. The
 *   Phase-16 integer-binding fix is already in place — this test locks that behavior so
 *   a future regression is caught before it reaches the device.
 *
 * References:
 *   - 29-CONTEXT.md D-06, D-11
 *   - 29-PATTERNS.md § "canonical-binding.spec.ts (new test — D-06 + D-11)"
 *   - elections-signing-seam.spec.ts Test B (D-11 structural analog)
 *   - digest-parity.spec.ts (DB setup pattern + no-colon-prefix binding convention)
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { prepareDb } from '../src/database/initialize.js'
import { DIGEST_VECTORS } from './fixtures/digest-vectors.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeElectionInit,
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { Signature } from '@votetorrent/vote-core'

// OLD |‐join SHA-256 value for Digest('hello') — computed as:
//   createHash('sha256').update('hello').digest('base64url')
// This is the value returned by the local digestSchema UDF (Phase <29 behavior).
// After Plan 29-02 lands the canonical plugin, Digest('hello') returns a DIFFERENT
// value and the D-06 inequality assertion below goes GREEN.
const OLD_PIJOIN_HELLO = 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ'

/** Build a sign callback from a key pair for use in test cases. */
function makeSignCallback(privateHex: string, userId: string, signerKey: string) {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: userId,
    signerKey,
    signature: bytesToHex(secp256k1.sign(digest, privBytes)),
  })
}

/** Normalise a Digest column value for comparison (handles Uint8Array / Buffer / string). */
function normalise(v: unknown): string {
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString('hex')
  }
  if (Buffer.isBuffer(v)) {
    return (v as Buffer).toString('hex')
  }
  return String(v)
}

describe('Canonical digest binding (Wave-0 Nyquist scaffolds)', () => {
  let db: Database

  before(async () => {
    db = new Database()
    await prepareDb(db)
  })

  // ---------------------------------------------------------------------------
  // D-06: canonical binding verified by behavior (RED until Plan 29-02)
  // ---------------------------------------------------------------------------

  it('D-06: Digest("hello") equals the regenerated canonical vector AND differs from old |‐join SHA-256', async () => {
    // Use the 'single-string' vector (args: ['hello']) from DIGEST_VECTORS —
    // D-02: the vector is the single source of truth; do not inline independently.
    const vec = DIGEST_VECTORS.find((v) => v.label === 'single-string')
    expect(vec, "DIGEST_VECTORS must contain a 'single-string' vector").to.exist

    const row = (await db
      .prepare('select Digest(:a0) as d')
      .get({ a0: vec!.args[0] })) as { d: unknown } | undefined

    // Shape assertion: must return a non-empty string.
    expect(row?.d, 'Digest("hello") must return a non-empty string').to.be.a('string').and.have.length.greaterThan(0)

    // Canonical equality assertion (D-02/D-06 GREEN gate — Plan 29-03):
    // The returned value must equal the regenerated canonical expected from DIGEST_VECTORS.
    // This proves binding-by-behavior: the live Digest() and the fixture agree.
    expect(row?.d, 'Digest("hello") must equal the canonical injective vector expected (DIGEST_VECTORS["single-string"])').to.equal(vec!.expected)

    // Inequality assertion: must NOT equal the old |‐join SHA-256 value.
    // If this fails, the stale UDF is still active — the plugin swap did not take effect.
    expect(row?.d, 'Digest("hello") must NOT equal the old |‐join SHA-256 — plugin swap must be active').to.not.equal(OLD_PIJOIN_HELLO)
  })

  // ---------------------------------------------------------------------------
  // D-11: INTEGER Tid regression lock (GREEN today — locks Phase-16 fix)
  // ---------------------------------------------------------------------------

  it('D-11 regression: context.Tid reaches SQL as INTEGER (not string) — stored Digest matches INTEGER Tid recompute', async () => {
    // The Phase-16 integer-binding fix is already in place across all engines.
    // This test PASSES today and must continue to pass — it locks the behavior
    // so a future regression is caught before it reaches the device (Hermes
    // distinguishes Digest(1, …) from Digest('1', …); the old pre-fix code used
    // String(tid) which caused InsertValid to fail on-device).

    const { privateHex, publicHex } = randomTestKeyPair()

    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: 'mobile' as any,
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

    // Capture the tid BEFORE calling seedElectionSigning so we know which integer to recompute.
    const tid = peekNextElectionTid()

    const sign = makeSignCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)
    await electionsEngine.createElection(init, { signingNonce })

    const engineDb = auth.ctx.db

    // Retrieve the stored Digest from AdminSigning for scope='mel'.
    const storedRow = (await engineDb
      .prepare("select Digest from AdminSigning where AuthorityId = :authorityId and Scope = 'mel' limit 1")
      .get({ authorityId: auth.authority.id })) as { Digest: unknown } | null
    expect(storedRow, 'AdminSigning mel row must exist').to.not.be.null

    // Recompute with INTEGER tid — the binding { tid: tid } passes a JS number
    // which Quereus maps to SQL INTEGER, matching context.Tid:int declarations.
    const { toCanonicalDatetime } = await import('../src/utils.js')
    const intRow = (await engineDb
      .prepare('select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d')
      .get({
        tid: tid, // INTEGER — must be a JS number, not String(tid)
        id: e.id,
        authorityId: e.authorityId,
        title: e.title,
        date: toCanonicalDatetime(e.date),
        revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
        ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
        type: e.type,
      })) as { d: unknown } | null

    const stored = normalise(storedRow!.Digest)
    const intDigest = normalise(intRow?.d)

    expect(stored, 'stored Digest matches INTEGER Tid recompute (context.Tid arrives as INTEGER)').to.equal(intDigest)
  })
})
