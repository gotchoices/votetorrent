/**
 * cid-signed-surface.spec.ts — Phase 36 Plan 03, Task 1: CID-03 end-to-end
 * signed-surface re-proof.
 *
 * PURPOSE: the Cid reformat (36-01/36-02: `InviteSlot.Cid` is now minted as a
 * real IPLD CIDv1 via `cid(Digest(...))` at all 3 authority-engine.ts producer
 * sites, not a bare `Digest(...)`-only hash string) sits inside the signed
 * blast radius:
 *   - the schema-level `InviteSlotSigningValid` assertion couples
 *     `AdminSigning.Digest = Digest(InviteSlot.Cid)` (votetorrent.qsql:452-459);
 *   - the app-side InviteResult signing chain
 *     (`H(SlotCid, Digest, IsAccepted)`, invitation-engine.ts A1 LOCKED
 *     encoding) signs directly over the Cid string.
 *
 * RESEARCH (36-RESEARCH.md) established that `Digest()`'s canonical
 * length-prefixed/type-tagged framing is agnostic to the *shape* of the
 * string it hashes — a CIDv1 multibase string hashes exactly like any other
 * TEXT arg — so no `DIGEST_VECTORS` golden-vector value needed to change.
 * This spec PROVES that end to end rather than assuming it:
 *
 *   1. re-confirms every committed `DIGEST_VECTORS` entry still matches the
 *      live `Digest()` scalar (Test 1) — the same live-recompute discipline
 *      `digest-parity.spec.ts` already runs on every suite run, re-asserted
 *      here explicitly because THIS is the spec that stands for the
 *      Cid-reformat signed-surface proof (CID-03 acceptance criteria);
 *   2. mints real `InviteSlot.Cid` values (au + of producer paths) and drives
 *      them through the `InviteSlotSigningValid` assertion via the full
 *      `saveInviteWithSigning` → `startSigningSession` pipeline — this is
 *      the exact `SIG.Digest = Digest(I2.Cid)` coupling the assertion
 *      enforces, now with `I2.Cid` a real CIDv1;
 *   3. confirms the minted Cid decodes as a genuine CIDv1 raw-codec value
 *      (`cid_decode` + `json_extract` codec check, mirroring the schema's
 *      own `SlotCidValid` structural form) — not just "some string";
 *   4. drives `InvitationEngine.respondToInvite`'s real A1 LOCKED
 *      `H(SlotCid, Digest, IsAccepted)` signing chain over that CIDv1
 *      SlotCid, independently verifies the resulting secp256k1 signature,
 *      and confirms the `InviteResult` row (whose `SlotCid` PK IS the CIDv1
 *      string) commits — proving `InviteResult.SlotCidValid` resolves for a
 *      real CIDv1 reference;
 *   5. cancels a separate pending slot via `AuthorityEngine.cancelInvite`,
 *      proving `InviteCancellation.SlotCidValid` also resolves for a real
 *      CIDv1 SlotCid reference.
 *
 * D-04 CLEAN-BREAK (documented per 36-CONTEXT.md): only NEWLY produced Cids
 * (from the 3 authority-engine.ts producer sites, post-36-02) are CIDv1.
 * Existing bare-hash Cid rows are NOT upgraded or migrated — no migration
 * tooling exists or is required in this phase. This is safe because the only
 * persisted stores carrying InviteSlot data are throwaway dev/on-device test
 * data (36-RESEARCH.md's Runtime State Inventory confirmed no production
 * persisted Cid data exists for this milestone) — a fresh schema attach
 * re-derives everything through the new `cid(Digest(...))` mint path from
 * that point forward. Any pre-existing bare-hash row would simply fail the
 * new `CidValid`/`SlotCidValid` CHECKs on next write, which is the accepted,
 * documented outcome (T-36-07 in this plan's threat register — disposition:
 * accept).
 *
 * BINDING CONVENTION: Quereus bind keys have NO colon prefix (see
 * digest-check-coverage.spec.ts header comment).
 *
 * D-02a: only the canonical `cid()`/`cid_decode()` entry points are
 * exercised (indirectly, via the real engine mint path, and directly via the
 * `assertRealCidv1` helper below) — the plugin's alternate single-hash entry
 * point is never referenced in this file (grep-locked by this plan's
 * acceptance criteria).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { DIGEST_VECTORS } from './fixtures/digest-vectors.js'
import type { Scope } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a fresh TestAuthorityContext for each test. */
async function setup (): Promise<TestAuthorityContext> {
  const net = await createTestNetwork()
  return addTestAuthority(net)
}

/**
 * Read back a minted `InviteSlot.Cid` and confirm it decodes as a genuine
 * CIDv1 raw-codec value — mirroring the schema's own `SlotCidValid`
 * structural form (`cast(json_extract(cid_decode(x), '$.codec') as text) =
 * 'raw'`, 36-01 Probe 3b cast-required finding). Proves "real CIDv1", not
 * merely "some string that happened to pass CidValid's re-derivation".
 */
async function assertRealCidv1 (auth: TestAuthorityContext, cid: string): Promise<void> {
  const row = await auth.ctx.db
    .prepare(`select cast(json_extract(cid_decode(:cid), '$.codec') as text) as codec`)
    .get({ cid })
  expect(row?.codec, `Cid ${cid} must decode as a genuine CIDv1 with codec 'raw'`).to.equal('raw')
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CID-03: signed surface embedding a real CIDv1 Cid (Phase 36 Plan 03)', function () {
  this.timeout(30_000)

  // -------------------------------------------------------------------------
  // Test 1: DIGEST_VECTORS confirmed unchanged (not assumed) by the Cid
  // column reformat — Digest()'s framing is agnostic to the Cid's shape.
  // -------------------------------------------------------------------------
  it('DIGEST_VECTORS: every committed golden vector still matches the live Digest() scalar (no regen needed)', async () => {
    const auth = await setup()
    for (const vec of DIGEST_VECTORS) {
      const placeholders = vec.args.map((_, i) => `:a${i}`).join(', ')
      const bindings = Object.fromEntries(vec.args.map((v, i) => [`a${i}`, v]))
      const sql = vec.args.length === 0 ? 'select Digest() as d' : `select Digest(${placeholders}) as d`
      const row = await auth.ctx.db.prepare(sql).get(bindings) as { d: unknown } | undefined
      expect(row?.d, `vector ${vec.label} must be unchanged by the Cid-column reformat`).to.equal(vec.expected)
    }
  })

  // -------------------------------------------------------------------------
  // Test 2: officer-invite path — InviteSlotSigningValid resolves end-to-end
  // with a real CIDv1 Cid (SIG.Digest = Digest(I2.Cid) coupling).
  // -------------------------------------------------------------------------
  it('InviteSlotSigningValid resolves end-to-end with a real CIDv1 InviteSlot.Cid (officer invite path)', async () => {
    const auth = await setup()
    const officerInvite = auth.authorityEngine.createOfficerInvite({
      name: 'Signed Surface Officer', title: 'Member', scopes: ['rad'] as Scope[],
    })
    const signCallback = makeTestSignCallback(auth.user)

    let errorThrown: Error | undefined
    try {
      await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, signCallback)
    } catch (e) {
      errorThrown = e as Error
    }
    expect(errorThrown, `saveInviteWithSigning threw unexpectedly: ${errorThrown?.message}`).to.be.undefined

    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
      .get({ inviteKey: officerInvite.inviteKey }) as { Cid: string } | undefined
    expect(slotRow?.Cid, 'InviteSlot row must exist after saveInviteWithSigning').to.be.a('string')
    await assertRealCidv1(auth, slotRow!.Cid)
  })

  // -------------------------------------------------------------------------
  // Test 3: authority-invite path — same coupling, the other au mint site.
  // -------------------------------------------------------------------------
  it('InviteSlotSigningValid resolves end-to-end with a real CIDv1 InviteSlot.Cid (authority invite path)', async () => {
    const auth = await setup()
    const authorityInvite = auth.authorityEngine.createAuthorityInvite('Signed Surface Authority')
    const signCallback = makeTestSignCallback(auth.user)

    let errorThrown: Error | undefined
    try {
      await auth.authorityEngine.saveInviteWithSigning(authorityInvite, 'iad' as Scope, signCallback)
    } catch (e) {
      errorThrown = e as Error
    }
    expect(errorThrown, `saveInviteWithSigning threw unexpectedly: ${errorThrown?.message}`).to.be.undefined

    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
      .get({ inviteKey: authorityInvite.inviteKey }) as { Cid: string } | undefined
    expect(slotRow?.Cid, 'InviteSlot row must exist after saveInviteWithSigning').to.be.a('string')
    await assertRealCidv1(auth, slotRow!.Cid)
  })

  // -------------------------------------------------------------------------
  // Test 4: app-side H(SlotCid, Digest, IsAccepted) signing chain resolves
  // correctly over a real CIDv1 SlotCid — InviteResult.SlotCidValid also
  // resolves (SlotCid is the InviteResult PK, referencing InviteSlot.Cid).
  // -------------------------------------------------------------------------
  it('InvitationEngine.respondToInvite signs H(SlotCid, Digest, IsAccepted) correctly over a real CIDv1 SlotCid, and InviteResult.SlotCidValid resolves', async () => {
    const auth = await setup()
    const officerInvite = auth.authorityEngine.createOfficerInvite({
      name: 'Signed Surface Acceptor', title: 'Member', scopes: ['rad'] as Scope[],
    })
    const signCallback = makeTestSignCallback(auth.user)
    await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, signCallback)

    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
      .get({ inviteKey: officerInvite.inviteKey }) as { Cid: string } | undefined
    const slotCid = slotRow!.Cid
    await assertRealCidv1(auth, slotCid)

    const invitationEngine = new InvitationEngine(auth.ctx)
    const digestValue = 'cid-signed-surface-accept-digest'

    let errorThrown: Error | undefined
    try {
      await invitationEngine.respondToInvite(slotCid, true, officerInvite.invitePrivate, digestValue)
    } catch (e) {
      errorThrown = e as Error
    }
    expect(errorThrown, `respondToInvite threw unexpectedly: ${errorThrown?.message}`).to.be.undefined

    // InviteResult.SlotCid PK IS the real CIDv1 string — its own commit above
    // already proved SlotCidValid resolves (a malformed reference would have
    // thrown, per cid-check-coverage.spec.ts case (e)). Independently verify
    // the A1 LOCKED signature was produced correctly OVER that CIDv1 string.
    const resultRow = await auth.ctx.db
      .prepare('select IsAccepted, Digest, InviteSignature from InviteResult where SlotCid = :slotCid')
      .get({ slotCid }) as { IsAccepted: boolean | number; Digest: string; InviteSignature: string } | undefined
    expect(resultRow, 'InviteResult row must exist for the accepted invite').to.exist
    expect(resultRow!.Digest).to.equal(digestValue)

    // A1 LOCKED ENCODING (invitation-engine.ts respondToInvite): the signed
    // domain is TextEncoder.encode([slotCid, digestToken, String(accept)].join('|')),
    // signed via secp256k1.sign(sha256(signedBytes), invitePrivBytes) — noble
    // v2 defaults (prehash:true). Recompute independently and verify.
    const signedBytes = new TextEncoder().encode([slotCid, digestValue, 'true'].join('|'))
    const verified = secp256k1.verify(
      hexToBytes(resultRow!.InviteSignature),
      sha256(signedBytes),
      hexToBytes(officerInvite.inviteKey),
    )
    expect(verified, 'H(SlotCid, Digest, IsAccepted) signature must verify over the real CIDv1 SlotCid').to.equal(true)
  })

  // -------------------------------------------------------------------------
  // Test 5: InviteCancellation.SlotCidValid also resolves for a real CIDv1
  // SlotCid reference (a separate pending slot, not the one accepted above).
  // -------------------------------------------------------------------------
  it('InviteCancellation.SlotCidValid resolves for a real CIDv1 SlotCid reference', async () => {
    const auth = await setup()
    const officerInvite = auth.authorityEngine.createOfficerInvite({
      name: 'Signed Surface Cancellee', title: 'Member', scopes: ['rad'] as Scope[],
    })
    const signCallback = makeTestSignCallback(auth.user)
    await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, signCallback)

    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
      .get({ inviteKey: officerInvite.inviteKey }) as { Cid: string } | undefined
    const slotCid = slotRow!.Cid
    await assertRealCidv1(auth, slotCid)

    let errorThrown: Error | undefined
    try {
      await auth.authorityEngine.cancelInvite(slotCid)
    } catch (e) {
      errorThrown = e as Error
    }
    expect(errorThrown, `cancelInvite threw unexpectedly: ${errorThrown?.message}`).to.be.undefined

    const cancelRow = await auth.ctx.db
      .prepare('select SlotCid from InviteCancellation where SlotCid = :slotCid')
      .get({ slotCid }) as { SlotCid: string } | undefined
    expect(cancelRow?.SlotCid, 'InviteCancellation row must exist referencing the real CIDv1 SlotCid').to.equal(slotCid)
  })
})
