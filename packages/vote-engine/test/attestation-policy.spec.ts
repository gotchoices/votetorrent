/**
 * attestation-policy.spec.ts — Phase 45-03 real-engine spec for
 * `ElectionAttestationPolicy` CRUD (D-14b).
 *
 * Covers (per 45-03-PLAN.md Task 2):
 *   - setElectionAttestationPolicy inserts a row via a mel-scoped AdminSigning
 *     ceremony; getElectionAttestationPolicy round-trips the stored flag.
 *   - setElectionAttestationPolicy is an UPSERT (single row per election,
 *     PK=ElectionId alone) — a second call with a different value replaces
 *     the row rather than erroring or duplicating it.
 *   - getElectionAttestationPolicy returns undefined when no policy row exists
 *     (the fail-closed *enforcement* branch belongs to 45-04's associate()
 *     ceremony; this plan only proves the read returns undefined, not any
 *     default-true synthesis).
 *   - A wrong-scope negative case: a ceremony signed under 'vrg' (instead of
 *     'mel') is rejected by the schema's own MutationValid CHECK, not an
 *     app-layer-only gate.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection, seedSignedMutation as seedSignedMutationFixture } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

async function setup (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
  electionId: string
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
  const sign = makeRealSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign, electionId }
}

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

// ===========================================================================
// ElectionAttestationPolicy CRUD (D-14b)
// ===========================================================================

describe('ElectionAttestationPolicy', () => {
  it('setElectionAttestationPolicy inserts a row via a mel-scoped AdminSigning ceremony; getElectionAttestationPolicy round-trips it', async () => {
    const { auth, engine, sign, electionId } = await setup()

    await engine.setElectionAttestationPolicy(electionId, true, sign)

    const row = await auth.ctx.db
      .prepare('select AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
      .get({ electionId })
    expect(Number(row?.AttestationRequired)).to.equal(1)

    const signingRow = await auth.ctx.db
      .prepare(`select Scope from AdminSigning where AuthorityId = :id and Scope = 'mel' order by Nonce desc limit 1`)
      .get({ id: auth.authority.id })
    expect(signingRow?.Scope).to.equal('mel')

    const policy = await engine.getElectionAttestationPolicy(electionId)
    expect(policy).to.not.be.undefined
    expect(policy!.electionId).to.equal(electionId)
    expect(policy!.attestationRequired).to.equal(true)
  })

  it('setElectionAttestationPolicy is an upsert — a second call with a different value replaces the single row (no duplicate)', async () => {
    const { auth, engine, sign, electionId } = await setup()

    await engine.setElectionAttestationPolicy(electionId, true, sign)
    await engine.setElectionAttestationPolicy(electionId, false, sign)

    const countRow = await auth.ctx.db
      .prepare('select count(*) as n from ElectionAttestationPolicy where ElectionId = :electionId')
      .get({ electionId })
    expect(Number(countRow?.n)).to.equal(1)

    const policy = await engine.getElectionAttestationPolicy(electionId)
    expect(policy!.attestationRequired).to.equal(false)
  })

  it('getElectionAttestationPolicy returns undefined when no policy row exists for the election', async () => {
    const { engine, electionId } = await setup()

    const policy = await engine.getElectionAttestationPolicy(electionId)
    expect(policy).to.be.undefined
  })

  describe('wrong-scope rejection (schema CHECK, not app-layer-only)', () => {
    it('rejects an ElectionAttestationPolicy insert whose ceremony was signed under vrg instead of mel', async () => {
      const { auth, electionId } = await setup()
      const tid = Date.now() + Math.floor(Math.random() * 100_000)
      const digestExpr = 'select Digest(:tid, :electionId, :attestationRequired) as d'
      const digestParams = { tid, electionId, attestationRequired: 1 }
      // Sign the ceremony under 'vrg' (wrong scope for ElectionAttestationPolicy,
      // which requires 'mel') instead of the correct 'mel'.
      const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'vrg', tid, digestExpr, digestParams, auth.user)

      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `insert into ElectionAttestationPolicy (ElectionId, AttestationRequired)
           with context SigningNonce = :nonce, Tid = ${tid}
           values (:electionId, :attestationRequired)`,
          { electionId, attestationRequired: 1, nonce }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'expected the vrg-scoped ceremony to be rejected by ElectionAttestationPolicy.MutationValid (requires mel)').to.be.instanceOf(Error)

      const row = await auth.ctx.db
        .prepare('select count(*) as n from ElectionAttestationPolicy where ElectionId = :electionId')
        .get({ electionId })
      expect(Number(row?.n)).to.equal(0)
    })
  })
})
