/**
 * association-request-transport-conformance.p2p.spec.ts — Phase 62 Plan 15 (D-23): un-skips this
 * plan's own reserved peer-cluster conformance slot, running it always-on against a real
 * `P2pAssociationTransport` over an in-process Quereus database carrying the real votetorrent
 * schema and UDFs.
 *
 * ============================================================================
 * WHY A SIDECAR, NOT AN EDIT
 * ============================================================================
 * `association-request-transport-conformance.spec.ts` carries committed structural gates —
 * including one asserting that file contains ZERO case-insensitive matches for
 * `p2p-association-transport|CadreNode|strand|optimystic|db-p2p`, and gates asserting its
 * shared-body sentinel region and its test-case counts are undisturbed. This file is a SIDECAR: it
 * imports that file's exported `runAssociationRequestTransportConformance` function and calls it
 * once more, from outside that file, with a real sealed-staging factory. That file is not touched
 * by this plan at all — its structural gates and test-case counts stay byte-unchanged.
 *
 * ============================================================================
 * THE BRANCH RUNS, AND WHAT THAT DOES NOT PROVE
 * ============================================================================
 * This slot now runs always-on against an in-process Quereus database with the real
 * votetorrent schema and UDFs. Every staging row (both legs) is sealed (D-03), requester-signed
 * and CHECK-verified (D-05), and every decision is officer-signed and CHECK-verified (D-06),
 * carrying D-41/D-45's RevokesDeviceKey/MatchMethod columns in 62-01's exact shapes.
 *
 * This proves interface, cursor, digest and schema conformance on ONE database. It does NOT
 * prove replication, a cohort, or P2P-11. The peer-cluster leg stays **code-complete, unverified
 * on devices**, and device delivery is proof debt against P2P-11 (`62-30`). Cross-peer evidence
 * lives in the opt-in two-node harness specs (`*.harness.spec.ts`), not here. **This phase has NO
 * dependency on P2P-11** — the filesystem binding (51-06), the REST binding (51-06), and the
 * shared conformance suite (51-07 Task 2) are already complete and contain no P2P code; if this
 * sidecar and the module it exercises were both deleted outright, none of that would regress.
 * P2P-11 was root-caused 2026-08-24 (devices refused as cadre non-members) and remains open, with
 * its wall having moved repeatedly across Phases 38 and 41 and again since.
 *
 * ============================================================================
 * DECLARED BLIND SPOT
 * ============================================================================
 * What this file proves, even with a REAL schema underneath: that `P2pAssociationTransport`
 * satisfies the SAME interface with the SAME cursor and digest semantics as the filesystem and
 * REST bindings, and that its sealed staging/decision rows (both legs) pass the schema's own
 * CHECKs on one in-process database. It can NEVER prove that peers form a cohort, that the
 * authority is reachable in a clustered manner, or that P2P-11 is closed — those are device/host
 * proofs this suite does not attempt and cannot substitute for.
 */

import { runAssociationRequestTransportConformance } from './association-request-transport-conformance.spec.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

// ---------------------------------------------------------------------------
// Types derived structurally from the exported function's own signature — the conformance spec
// exports only `runAssociationRequestTransportConformance`, not `ConformanceCase`/
// `ConformanceBinding` by name, so this sidecar extracts them via TypeScript utility types rather
// than re-declaring anything (which would risk the two branches drifting apart, exactly what
// D-08's one-suite requirement exists to prevent).
// ---------------------------------------------------------------------------
type ConformanceCase = Parameters<typeof runAssociationRequestTransportConformance>[0]
type ConformanceBindingFactory = ConformanceCase['make']
type DigestIssuer = Parameters<ConformanceBindingFactory>[0]
type ConformanceBinding = Awaited<ReturnType<ConformanceBindingFactory>>

let fixture: P2pStagingFixture
let strandSeq = 0

/**
 * The real factory filling this plan's reserved slot, over a real `P2pAssociationTransport` and a
 * real in-process Quereus database (`createP2pStagingFixture`). Every submit (both legs) is
 * sealed (D-03) and requester-signed (D-05); every decision is signed by the fixture's founding
 * 'vrg' officer (D-06) and verified by the schema's own `DeciderIsOfficerWithScope` CHECK. Status
 * is NOT validated on write — case 5 (`'x'`) relies on the schema's own lack of a Status
 * vocabulary CHECK on `AssociationDecision`, exactly as production.
 */
async function makeP2pBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  strandSeq += 1
  const strandId = `p2p-conformance-${strandSeq}`
  const port = fixture.makePort()

  // The base conformance body's own `makeInit()` hardcodes `authorityId: 'conformance-authority'`
  // — a label with no relation to the fixture's real authority id. The D-03
  // `sealer-authority-mismatch` guard only fires when `sealer.authorityId` is SET, so this sidecar
  // seals through a thin wrapper with no `authorityId` of its own, opting out of a guard the base
  // suite was never written to satisfy (the guard itself is proven directly in
  // `p2p-staging-transport.spec.ts`).
  const sealer = { seal: fixture.sealer.seal.bind(fixture.sealer) }

  const transport = new P2pAssociationTransport({
    openStrand: async () => port as unknown as AssociationStrandPort,
    computeDigest: async (init, requesterKey) => issuer.issueRequest(init, requesterKey).digest,
    computeAttestationDigest: async (answer, requesterKey) => issuer.issueAttestation(answer, requesterKey).digest,
    strandId,
    sealer,
    opener: fixture.opener,
    decisionSigner: fixture.decisionSigner
  })

  return {
    label: 'p2p-binding',
    transport,
    async deliveredRequests () {
      return await transport.readStagedRequests()
    },
    async deliveredAttestations () {
      return await transport.readStagedAttestations()
    },
    async publishDecision (decision: { requestId: string, status: string, challengeNonce?: string, reason?: string }) {
      // decidedAt is this binding's own write-time marker, unrelated to the submitter's
      // submittedAt — same discipline the filesystem/rest factories use. `status` crosses the
      // seam as a bare string (case 5 drives 'x' through it); the transport itself never
      // validates it on write, matching 62-01's `AssociationDecision` (no Status vocabulary CHECK).
      return await transport.publishDecision({
        requestId: decision.requestId,
        status: decision.status as Parameters<typeof transport.publishDecision>[0]['status'],
        challengeNonce: decision.challengeNonce,
        reason: decision.reason,
        decidedAt: new Date().toISOString()
      })
    },
    async close () {
      await transport.close()
    }
  }
}

describe('p2p sidecar on an in-process strand database', function () {
  this.timeout(30_000)

  before(async function () {
    fixture = await createP2pStagingFixture()
  })

  runAssociationRequestTransportConformance({
    label: 'p2p-binding',
    mode: 'run',
    make: makeP2pBinding
  })
})
