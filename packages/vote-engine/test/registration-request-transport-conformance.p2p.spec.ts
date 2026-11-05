/**
 * registration-request-transport-conformance.p2p.spec.ts — Phase 62 Plan 15 (D-23): un-skips
 * 48-13's reserved peer-cluster conformance slot, running it always-on against a real
 * `P2pRegistrationTransport` over an in-process Quereus database carrying the real votetorrent
 * schema and UDFs.
 *
 * ============================================================================
 * WHY A SIDECAR, NOT AN EDIT
 * ============================================================================
 * `registration-request-transport-conformance.spec.ts` carries committed structural gates —
 * including one asserting that file contains ZERO case-insensitive matches for
 * `p2p-registration-transport|CadreNode|strand|optimystic|db-p2p`, and gates asserting its
 * shared-body sentinel region and its `it()` counts are undisturbed. This file is a SIDECAR: it
 * imports 48-13's exported `runRegistrationRequestTransportConformance` function and calls it
 * once more, from outside that file, with a real sealed-staging factory. 48-13's own file is not
 * touched by this plan at all — its structural gates and `it()` counts stay byte-unchanged.
 *
 * ============================================================================
 * THE BRANCH RUNS, AND WHAT THAT DOES NOT PROVE
 * ============================================================================
 * This slot now runs always-on against an in-process Quereus database with the real
 * votetorrent schema and UDFs. Every staging row is sealed (D-03), requester-signed and
 * CHECK-verified (D-05), and every decision is officer-signed and CHECK-verified (D-06).
 *
 * This proves interface, cursor, digest and schema conformance on ONE database. It does NOT
 * prove replication, a cohort, or P2P-11. The peer-cluster leg stays **code-complete, unverified
 * on devices**, and device delivery is proof debt against P2P-11 (`62-30`). Cross-peer evidence
 * lives in the opt-in two-node harness specs (`*.harness.spec.ts`), not here. Node and mocha
 * results passing here are NOT verification that peers reach a cohort — that project has a
 * documented history of "implemented but unproven" being read as "done" (Phase 45 closed with
 * four such legs; Phase 41's Node gate was device-REFUTED).
 *
 * ============================================================================
 * DECLARED BLIND SPOT
 * ============================================================================
 * What this file proves, even with a REAL schema underneath: that `P2pRegistrationTransport`
 * satisfies the SAME interface with the SAME cursor and digest semantics as the filesystem and
 * REST bindings, and that its sealed staging/decision rows pass the schema's own CHECKs on one
 * in-process database. It can NEVER prove that peers form a cohort, that the authority is
 * reachable in a clustered manner, or that P2P-11 is closed — those are device/host proofs this
 * suite does not attempt and cannot substitute for. See
 * `.planning/phases/48-.../48-P2P-STATUS.md` for the execution-time record of what the live wall
 * actually looked like when this leg was first written.
 */

import { runRegistrationRequestTransportConformance } from './registration-request-transport-conformance.spec.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationRequestStatus } from '@votetorrent/vote-core'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

// ---------------------------------------------------------------------------
// Types derived structurally from the exported function's own signature — 48-13 exports only
// `runRegistrationRequestTransportConformance`, not `ConformanceCase`/`ConformanceBinding` by
// name, so this sidecar extracts them via TypeScript utility types rather than re-declaring
// anything (which would risk the two branches drifting apart, exactly what D-01's one-suite
// requirement exists to prevent).
// ---------------------------------------------------------------------------
type ConformanceCase = Parameters<typeof runRegistrationRequestTransportConformance>[0]
type ConformanceBindingFactory = ConformanceCase['make']
type DigestIssuer = Parameters<ConformanceBindingFactory>[0]
type ConformanceBinding = Awaited<ReturnType<ConformanceBindingFactory>>

let fixture: P2pStagingFixture
let strandSeq = 0

/**
 * The real factory filling 48-13's reserved slot, over a real `P2pRegistrationTransport` and a
 * real in-process Quereus database (`createP2pStagingFixture`). Every submit is sealed (D-03)
 * and requester-signed (D-05); every decision is signed by the fixture's founding 'vrg' officer
 * (D-06) and verified by the schema's own `DeciderIsOfficerWithScope` CHECK.
 *
 * `capturedWireText()` must be SYNCHRONOUS per the shared `ConformanceBinding` contract, but a
 * real database read is not — `deliveredSubmissions()`/`publishDecision()` refresh a cached
 * string as a side effect of their own (awaited) DB read, and the shared body's only two call
 * sites for `capturedWireText()` (cases 1 and 4) both follow a `deliveredSubmissions()` await, so
 * the cache is always fresh when read.
 */
async function makeP2pBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  strandSeq += 1
  const strandId = `p2p-conformance-${strandSeq}`
  const overlay = new Map<string, string>()
  const port = fixture.makePort({ overlay })

  let wireTextCache = ''
  async function refreshWireTextCache (): Promise<void> {
    const staging = await fixture.rawRows('RegistrationRequestStaging', strandId)
    const decisions = await fixture.rawRows('RegistrationDecision', strandId)
    wireTextCache = JSON.stringify({ staging, decisions })
  }

  // The base conformance body's own `makeInit()` hardcodes `authorityId: 'conformance-authority'`
  // — a label with no relation to the fixture's real authority id. The D-03
  // `sealer-authority-mismatch` guard only fires when `sealer.authorityId` is SET, so this sidecar
  // seals through a thin wrapper with no `authorityId` of its own, opting out of a guard the base
  // suite was never written to satisfy (the guard itself is proven directly in
  // `p2p-staging-transport.spec.ts`).
  const sealer = { seal: fixture.sealer.seal.bind(fixture.sealer) }

  const transport = new P2pRegistrationTransport({
    openStrand: async () => port as unknown as RegistrationStrandPort,
    computeDigest: async (init, requesterKey) => issuer.issue(init, requesterKey).digest,
    strandId,
    sealer,
    opener: fixture.opener,
    decisionSigner: fixture.decisionSigner
  })

  return {
    label: 'p2p-binding',
    transport,
    async deliveredSubmissions () {
      const delivered = await transport.readStagedRequests()
      await refreshWireTextCache()
      return delivered
    },
    async publishDecision (decision: { requestId: string, status: RegistrationRequestStatus, reason?: string }) {
      // decidedAt is this binding's own write-time marker, unrelated to the submitter's
      // submittedAt — same discipline the filesystem/rest factories use.
      const cursor = await transport.publishDecision({ ...decision, decidedAt: new Date().toISOString() })
      await refreshWireTextCache()
      return cursor
    },
    async tamperDeliveredPayload (requestId: string) {
      // The schema refuses UPDATE and DELETE on staging rows (D-07), so this re-seal models a
      // hostile peer or relay serving re-sealed bytes over the delivery path, never a mutation of
      // the durable row itself. Anyone can re-seal to the (public) recipient keys named in an
      // envelope — detection rests entirely on the requester's own signature over the row's
      // unchanged, stored Digest, exactly as in the filesystem and REST bindings.
      const row = (await fixture.rawRows('RegistrationRequestStaging', strandId)).find((r) => r.RequestId === requestId)
      if (row === undefined) {
        throw new Error(`makeP2pBinding.tamperDeliveredPayload: no staged row for ${requestId}`)
      }
      const digest = row.Digest as string
      const opened = await fixture.opener.open(row.InitJson as string, { requestId, digest })
      if (!opened.ok) {
        throw new Error(`makeP2pBinding.tamperDeliveredPayload: fixture opener could not open the row for ${requestId}`)
      }
      const plaintext = JSON.parse(opened.plaintext) as { version: 1, init: { payload: Record<string, unknown> }, registrationCode?: string }
      const tampered = { ...plaintext, init: { ...plaintext.init, payload: { ...plaintext.init.payload, __tampered: true } } }
      const resealed = await fixture.sealer.seal(JSON.stringify(tampered), { requestId, digest })
      overlay.set(requestId, resealed)
    },
    capturedWireText () {
      return wireTextCache
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

  runRegistrationRequestTransportConformance({
    label: 'p2p-binding',
    mode: 'run',
    make: makeP2pBinding
  })
})
