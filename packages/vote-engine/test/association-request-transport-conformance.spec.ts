/**
 * association-request-transport-conformance.spec.ts — Phase 51 Plan 07
 * (D-08/D-18): the shared association-request transport-conformance suite.
 *
 * ============================================================================
 * 1. WHAT THIS PROVES
 * ============================================================================
 * D-08's claim is that `IAssociationRequestTransport`'s real bindings are
 * INTERCHANGEABLE. The only evidence for interchangeability is that the SAME
 * assertions ran against both. This file makes that mechanically true, not
 * merely claimed: the seven conformance cases (one per `<behavior>` bullet in
 * 51-07-PLAN.md's Task 2) are written EXACTLY ONCE, inside one exported
 * function delimited by a matching pair of numbered-comment sentinels (see
 * below). That function is called exactly ONCE, from a loop over a
 * three-entry binding table (filesystem, rest, and a reserved peer-cluster
 * slot). Seven test-case literals therefore produce FOURTEEN passing tests —
 * seven per running binding. If an executor ever duplicates the body per
 * binding instead of sharing it, the test-case count inside the sentinel
 * region rises above seven and the structural regression gate fails: a
 * duplicated body is a GATE FAILURE, not a style preference.
 *
 * ============================================================================
 * 2. TWO LEGS, ASSERTED SEPARATELY (D-18)
 * ============================================================================
 * Association is NOT single-round-trip the way registration is: the
 * authority must hand the device a nonce BEFORE the device can attest,
 * because the nonce is bound INTO the attestation itself. `submitRequest`
 * (leg 1, the self-signed ask) and `submitAttestation` (leg 2, D-18's
 * distinct second message) therefore get their OWN test cases with their
 * OWN assertions in this suite — never one case that branches on payload shape.
 * That blurring is exactly what D-18's rejected alternative (a widened
 * `submitRequest` carrying an optional payload) would have caused, and this
 * suite's structural gate below checks for it directly (no
 * `payload.kind ===`-style branch inside the sentinel region).
 *
 * ============================================================================
 * 3. THE THIRD SLOT
 * ============================================================================
 * The peer-cluster binding (51-07 Task 1's module, the p2p peer-cluster
 * transport binding) gets a THIRD entry in the binding table, `{ label: 'p2p', mode: 'skip',
 * ... }`. Its seven cases render as PENDING — never passing, never absent.
 *
 * A skipped branch cannot fail a wave, and it cannot pass one either.
 *
 * The peer-cluster leg is **code-complete, unverified** (D-08, mirroring
 * Phase 48 D-11's framing verbatim), and even once a later plan flips this
 * slot's `mode` to `'run'` and supplies a real peer-cluster-backed factory, **Node
 * and mocha results are not verification for it.** A later reader must not
 * "fix" this skip by deleting it, flipping it early, or converting it to
 * `it.skip`. This file imports NO peer-cluster transport module at all.
 *
 * ============================================================================
 * 4. DECLARED BLIND SPOT — narrower than it looks
 * ============================================================================
 * NARROWED BY CR-03 (51-REVIEW). `createDigestIssuer()` below used to be a test-local
 * stand-in — a `sha256` over a `field=value` join, with leg 2's field order entirely
 * invented. It is no longer. Both legs now go through
 * `src/association/transport/association-request-digest.ts`, the SAME pure helper
 * `RestAssociationTransport` uses to reject an endpoint-chosen digest, whose parity with a
 * LIVE `select Digest(...)` is asserted byte-for-byte in `association-request-digest.spec.ts`.
 * The field orders are consequently the real, load-bearing ones:
 *   - leg 1 — `Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt`
 *     (`AssociationRequest.SignatureValid`, recorded in `51-01-SUMMARY.md`);
 *   - leg 2 — `RequestId, Nonce, AttestationJson, DeviceHash`, matching
 *     `AssociationEngine.validateStagedAttestationAnswer` and the bridge
 *     (`scripts/device-proof/association-rest-bridge.mjs`). Leg 2 still has NO schema
 *     `SignatureValid`-style CHECK behind it — it is engine-enforced only (T-51-08-06) — but
 *     the order is now the engine's, not this suite's invention.
 * What REMAINS a blind spot: this suite still does not drive a real `AssociationEngine` write,
 * so it does not prove a delivered signature satisfies the schema's `SignatureValid` CHECK
 * end to end. That is 51-08/51-09's job (an offline pre-resolved-signature round-trip against
 * the real schema, exactly as `registration-request.spec.ts` already does for registration) —
 * not this suite's.
 *
 * ============================================================================
 * 5. WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT
 * ============================================================================
 * Neither transport REJECTS a malformed or adversarial document — they are
 * couriers (both bindings' own headers state this explicitly), and the
 * schema's `SignatureValid` CHECK (or, for leg 2, whatever the authority-side
 * ceremony eventually enforces) is the actual authorization gate. What this
 * suite proves is narrower and structural: that a staged document's fields
 * (`requestId`, `submittedAt`, `signature`) round-trip byte-identically
 * through either binding, that the two legs are never conflated, and that an
 * unknown decision-status code is surfaced loudly rather than silently
 * dropped.
 *
 * ============================================================================
 * 6. NO CLAIM OF SCOPE ENFORCEMENT
 * ============================================================================
 * This file touches no ceremony. No sentence in this file claims that the
 * 'vrg' label gates anything.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { AssociationAttestationAnswer, AssociationRequestInit, DeviceAttestation, Signature } from '@votetorrent/vote-core'
import { FilesystemAssociationTransport } from '../src/association/transport/filesystem-association-transport.js'
import type { StagedAssociationRequest, StagedAttestation, AssociationDecisionDocument } from '../src/association/transport/filesystem-association-transport.js'
import { RestAssociationTransport } from '../src/association/transport/rest-association-transport.js'
import {
  computeAssociationAttestationDigest,
  computeAssociationRequestDigest
} from '../src/association/transport/association-request-digest.js'
import { digestToBytes } from '../src/utils.js'
import type { IAssociationRequestTransport } from '../src/association/transport/association-request-transport.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// ---------------------------------------------------------------------------
// B. Digest field orders — one frozen constant per leg, at module top level.
//
// Leg 1's order is the REAL, load-bearing `AssociationRequest.SignatureValid`
// argument order recorded in `51-01-SUMMARY.md`: `Digest(Id, AuthorityId,
// RegistrantId, DeviceKey, ElectionId, SubmittedAt)`. `requesterKey` is
// deliberately NOT one of its fields — `DeviceKey` occupies that role in the
// real ceremony, so every fixture below sets `requesterKey === init.deviceKey`
// (mirroring the device's own self-signature), though this suite does not
// enforce that equality structurally.
//
// Leg 2 has no schema CHECK behind it, but it DOES have a load-bearing engine-side order:
// `Digest(RequestId, Nonce, AttestationJson, DeviceHash)`, from
// `AssociationEngine.validateStagedAttestationAnswer` and served by the bridge. Both orders
// below are documentation of what the shared helper computes — the helper, not these arrays,
// is what actually produces the bytes (CR-03).
// ---------------------------------------------------------------------------
const REQUEST_DIGEST_FIELD_ORDER = Object.freeze([
  'id',
  'authorityId',
  'registrantId',
  'deviceKey',
  'electionId',
  'submittedAt'
] as const)

const ATTESTATION_DIGEST_FIELD_ORDER = Object.freeze([
  'requestId',
  'nonce',
  'attestationJson',
  'deviceHash'
] as const)

// ---------------------------------------------------------------------------
// C. createDigestIssuer() — the shared receiving-side digest authority for
// BOTH legs. Both harnesses below use the SAME issuer instance, so a
// field-order or timestamp divergence between the bindings cannot hide
// behind two separate digest computations.
// ---------------------------------------------------------------------------
interface RequestDigestRecord {
  submittedAt: string
  input: Record<string, string>
  digest: Uint8Array
}

interface AttestationDigestRecord {
  input: Record<string, string>
  digest: Uint8Array
}

interface DigestIssuer {
  issueRequest: (init: AssociationRequestInit, requesterKey: string) => RequestDigestRecord
  recordForRequest: (requestId: string) => RequestDigestRecord
  allocationCountForRequest: (requestId: string) => number
  issueAttestation: (answer: AssociationAttestationAnswer, requesterKey: string) => AttestationDigestRecord
  recordForAttestation: (requestId: string) => AttestationDigestRecord
  allocationCountForAttestation: (requestId: string) => number
}

/**
 * The pure leg-1 digest computation, independent of memoization. `init`'s
 * `submittedAt` is never generated, defaulted, or re-derived here — a
 * missing or malformed one is a fixture bug and throws loudly.
 */
function computeCanonicalRequestDigest (init: AssociationRequestInit, requesterKey: string): { input: Record<string, string>; digest: Uint8Array } {
  if (typeof init.submittedAt !== 'string' || init.submittedAt.length === 0 || !init.submittedAt.endsWith('Z')) {
    throw new Error(
      `computeCanonicalRequestDigest: init.submittedAt must be a non-empty Z-suffixed string (fixture bug), got ${JSON.stringify(init.submittedAt)}`
    )
  }
  // `requesterKey`, not `init.deviceKey`, occupies the DeviceKey position — that is what the
  // engine binds. Every fixture in this file sets them equal; the parameter exists so the
  // equality is visible rather than assumed.
  const input: Record<string, string> = {
    id: init.id,
    authorityId: init.authorityId,
    registrantId: init.registrantId,
    deviceKey: requesterKey,
    electionId: init.electionId ?? '',
    submittedAt: init.submittedAt
  }
  const digest = digestToBytes(computeAssociationRequestDigest(init, requesterKey))
  return { input, digest }
}

/** The pure leg-2 digest computation — the engine's own tuple (see header §4). */
function computeCanonicalAttestationDigest (answer: AssociationAttestationAnswer): { input: Record<string, string>; digest: Uint8Array } {
  const input: Record<string, string> = {
    requestId: answer.requestId,
    nonce: answer.nonce,
    attestationJson: JSON.stringify(answer.attestation),
    deviceHash: answer.deviceHash ?? ''
  }
  const digest = digestToBytes(computeAssociationAttestationDigest(answer))
  return { input, digest }
}

function createDigestIssuer (): DigestIssuer {
  const requestRecords = new Map<string, RequestDigestRecord>()
  const requestCounts = new Map<string, number>()
  const attestationRecords = new Map<string, AttestationDigestRecord>()
  const attestationCounts = new Map<string, number>()

  function issueRequest (init: AssociationRequestInit, requesterKey: string): RequestDigestRecord {
    requestCounts.set(init.id, (requestCounts.get(init.id) ?? 0) + 1)
    const existing = requestRecords.get(init.id)
    if (existing !== undefined) return existing
    const { input, digest } = computeCanonicalRequestDigest(init, requesterKey)
    const record: RequestDigestRecord = { submittedAt: init.submittedAt, input, digest }
    requestRecords.set(init.id, record)
    return record
  }

  function recordForRequest (requestId: string): RequestDigestRecord {
    const record = requestRecords.get(requestId)
    if (record === undefined) throw new Error(`createDigestIssuer.recordForRequest: no record for request ${requestId}`)
    return record
  }

  function allocationCountForRequest (requestId: string): number {
    return requestCounts.get(requestId) ?? 0
  }

  function issueAttestation (answer: AssociationAttestationAnswer, requesterKey: string): AttestationDigestRecord {
    attestationCounts.set(answer.requestId, (attestationCounts.get(answer.requestId) ?? 0) + 1)
    const existing = attestationRecords.get(answer.requestId)
    if (existing !== undefined) return existing
    void requesterKey // leg 2's engine tuple does not include it — DeviceHash occupies that slot.
    const { input, digest } = computeCanonicalAttestationDigest(answer)
    const record: AttestationDigestRecord = { input, digest }
    attestationRecords.set(answer.requestId, record)
    return record
  }

  function recordForAttestation (requestId: string): AttestationDigestRecord {
    const record = attestationRecords.get(requestId)
    if (record === undefined) throw new Error(`createDigestIssuer.recordForAttestation: no record for request ${requestId}`)
    return record
  }

  function allocationCountForAttestation (requestId: string): number {
    return attestationCounts.get(requestId) ?? 0
  }

  return {
    issueRequest,
    recordForRequest,
    allocationCountForRequest,
    issueAttestation,
    recordForAttestation,
    allocationCountForAttestation
  }
}

// ---------------------------------------------------------------------------
// D. makeRealSigner() — one closure, both branches, both legs.
// `signerUserId` is deliberately empty: a prospective registrant's device
// has a P-256/secp256k1 keypair but no `User` row (D-02), and neither
// binding may read that field.
// ---------------------------------------------------------------------------
function makeRealSigner (): { publicHex: string; privateHex: string; sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 defaults, two-argument form (WR-10) — no options object.
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
  return { publicHex, privateHex, sign }
}

// The one place a clock may touch a submittedAt position in this file: the
// SUBMITTER's own act, authored once behind a named helper rather than
// inline, so a grep for a clock reading substituted into the digest issuer
// or either harness (which never call this helper) stays meaningful.
function defaultSubmittedAt (): string {
  return new Date().toISOString()
}

let requestIdSeq = 0
function nextRequestId (): string {
  requestIdSeq += 1
  return `conf-assoc-req-${Date.now()}-${requestIdSeq}`
}

/** A valid `AssociationRequestInit` with a monotonic id so ids never collide
 * across cases. `deviceKey` defaults to the caller's own public key
 * (`requesterKey`), mirroring the real ceremony's self-signature. */
function makeInit (requesterKeyHex: string, overrides: Partial<AssociationRequestInit> = {}): AssociationRequestInit {
  const id = overrides.id ?? nextRequestId()
  return {
    id,
    authorityId: overrides.authorityId ?? 'conformance-authority',
    registrantId: overrides.registrantId ?? `registrant-${id}`,
    deviceKey: overrides.deviceKey ?? requesterKeyHex,
    electionId: overrides.electionId,
    submittedAt: overrides.submittedAt ?? defaultSubmittedAt()
  }
}

/** A valid `DeviceAttestation` fixture — shape only, never a real platform
 * attestation statement (this suite proves transport interchangeability, not
 * D-17's real ceremony). */
function makeAttestation (overrides: Partial<DeviceAttestation> = {}): DeviceAttestation {
  return {
    publicKey: overrides.publicKey ?? 'conformance-device-pubkey',
    deviceId: overrides.deviceId ?? `conformance-device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    attestationTime: overrides.attestationTime ?? Date.now(),
    certificateChain: overrides.certificateChain ?? ['conformance-leaf-cert']
  }
}

/** A valid `AssociationAttestationAnswer` — D-18's distinct second message.
 * Deliberately does NOT carry `registrantId`/`deviceKey` (per the type's own
 * documented rule: those are read back from the persisted request row, not
 * accepted from the wire). */
function makeAttestationAnswer (overrides: Partial<AssociationAttestationAnswer> = {}): AssociationAttestationAnswer {
  return {
    requestId: overrides.requestId ?? nextRequestId(),
    nonce: overrides.nonce ?? `conf-nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    attestation: overrides.attestation ?? makeAttestation(),
    deviceHash: overrides.deviceHash
  }
}

// ---------------------------------------------------------------------------
// E. The harness contract — parameterize over construction, not over a bare
// transport. The two bindings' construction shapes differ (injected digest
// functions vs. a live handshake); a factory returns a whole harness so each
// side can resolve that difference internally while exposing one shared
// surface to the conformance body.
// ---------------------------------------------------------------------------
interface ConformanceBinding {
  readonly label: string
  readonly transport: IAssociationRequestTransport
  deliveredRequests: () => Promise<StagedAssociationRequest[]>
  deliveredAttestations: () => Promise<StagedAttestation[]>
  /** `status` is loosely typed as `string`, not the closed vote-core union,
   * so behavior 5 (Task 2) can drive an out-of-vocabulary status through the
   * WRITE side and prove `pollDecisions` (the READ side) throws rather than
   * silently coercing it. */
  publishDecision: (decision: { requestId: string; status: string; challengeNonce?: string; reason?: string }) => Promise<string>
  close: () => Promise<void>
}

interface ConformanceCase {
  label: string
  mode: 'run' | 'skip'
  make: (issuer: DigestIssuer) => Promise<ConformanceBinding>
}

// ---------------------------------------------------------------------------
// F. Factory 1 — filesystem (51-06).
// ---------------------------------------------------------------------------
async function makeFilesystemBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const rootDir = await mkdtemp(join(tmpdir(), 'association-conformance-fs-'))

  const transport = new FilesystemAssociationTransport({
    rootDir,
    computeDigest: async (init, requesterKey) => issuer.issueRequest(init, requesterKey).digest,
    computeAttestationDigest: async (answer, requesterKey) => issuer.issueAttestation(answer, requesterKey).digest
  })

  return {
    label: 'filesystem',
    transport,
    async deliveredRequests () {
      return await transport.readStagedRequests()
    },
    async deliveredAttestations () {
      return await transport.readStagedAttestations()
    },
    async publishDecision (decision) {
      // decidedAt is this courier's own write-time marker (unrelated to,
      // and never substituted for, the submitter's submittedAt).
      return await transport.publishDecision({
        requestId: decision.requestId,
        status: decision.status as AssociationDecisionDocument['status'],
        challengeNonce: decision.challengeNonce,
        reason: decision.reason,
        decidedAt: new Date().toISOString()
      })
    },
    async close () {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// G. Factory 2 — REST (51-06). A throwaway node:http receiver implementing
// the wire protocol exactly as `rest-association-transport.ts`'s own header
// documents (R-1/R-2 per leg, plus the decisions poll).
// ---------------------------------------------------------------------------
interface SubmittedRequestRecord { init: AssociationRequestInit; requesterKey: string; signature: Signature; submittedAt: string; cursor: string }
interface SubmittedAttestationRecord { answer: AssociationAttestationAnswer; requesterKey: string; signature: Signature; stagedAt: string; cursor: string }
interface RawDecisionNotice { requestId: string; status: string; challengeNonce?: string; reason?: string; cursor: string }

async function makeRestBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const submittedRequests = new Map<string, SubmittedRequestRecord>()
  const submittedAttestations = new Map<string, SubmittedAttestationRecord>()
  const decisionNotices: RawDecisionNotice[] = []
  let requestSubmitSeq = 0
  let attestationSubmitSeq = 0
  let decisionSeq = 0

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(json)
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody)
        } catch {
          parsedBody = undefined
        }
      }
      const method = req.method ?? 'GET'
      const url = req.url ?? '/'

      if (method === 'POST' && url === '/association-requests/digest') {
        const body = parsedBody as { init: AssociationRequestInit; requesterKey: string }
        // R-1: the receiving side issues the digest AND echoes the
        // submitter's own submittedAt back beside it — issuer.issueRequest()
        // memoizes on the first call per request id, never re-derives.
        const issued = issuer.issueRequest(body.init, body.requesterKey)
        send(res, 200, { digest: bytesToHex(issued.digest), submittedAt: issued.submittedAt })
        return
      }

      if (method === 'POST' && url === '/association-requests') {
        const body = parsedBody as { init: AssociationRequestInit; requesterKey: string; submittedAt: string; signature: Signature }
        const memoized = issuer.recordForRequest(body.init.id).submittedAt
        if (body.submittedAt !== memoized || body.init.submittedAt !== memoized) {
          send(res, 400, { error: 'submittedAt disagreement across wire positions' })
          return
        }
        requestSubmitSeq += 1
        const cursor = `s${String(requestSubmitSeq).padStart(6, '0')}`
        submittedRequests.set(body.init.id, {
          init: body.init,
          requesterKey: body.requesterKey,
          signature: body.signature,
          submittedAt: memoized,
          cursor
        })
        send(res, 200, { requestId: body.init.id })
        return
      }

      if (method === 'POST' && url === '/association-attestations/digest') {
        const body = parsedBody as { answer: AssociationAttestationAnswer; requesterKey: string }
        // R-1 (leg 2): the digest handshake is dumb transit — it echoes
        // whatever requestId/nonce arrived in the body, with no check that
        // requestId was ever submitted through leg 1. That is the courier
        // behavior behavior 3 (Task 2) exercises.
        const issued = issuer.issueAttestation(body.answer, body.requesterKey)
        send(res, 200, { digest: bytesToHex(issued.digest), requestId: body.answer.requestId, nonce: body.answer.nonce })
        return
      }

      if (method === 'POST' && url === '/association-attestations') {
        const body = parsedBody as { answer: AssociationAttestationAnswer; requesterKey: string; signature: Signature }
        attestationSubmitSeq += 1
        const cursor = `t${String(attestationSubmitSeq).padStart(6, '0')}`
        submittedAttestations.set(body.answer.requestId, {
          answer: body.answer,
          requesterKey: body.requesterKey,
          signature: body.signature,
          stagedAt: new Date().toISOString(),
          cursor
        })
        send(res, 200, {})
        return
      }

      if (method === 'GET' && url.startsWith('/association-decisions')) {
        const parsedUrl = new URL(url, 'http://127.0.0.1')
        const since = parsedUrl.searchParams.get('since')
        // Zero-padded 'dNNNNNN'-style cursors make plain string comparison a
        // total order.
        const notices = decisionNotices.filter((notice) => since === null || notice.cursor > since)
        send(res, 200, { notices })
        return
      }

      send(res, 404, { error: 'not found' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Never a fixed port — ephemeral listen(0) only (this repo has been
    // bitten by port squatting before, e.g. Metro on :8081).
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const transport = new RestAssociationTransport({ baseUrl })

  return {
    label: 'rest',
    transport,
    async deliveredRequests () {
      const out: StagedAssociationRequest[] = []
      for (const rec of submittedRequests.values()) {
        out.push({
          version: 1,
          requestId: rec.init.id,
          init: rec.init,
          requesterKey: rec.requesterKey,
          signature: rec.signature,
          stagedAt: rec.submittedAt,
          cursor: rec.cursor
        })
      }
      return out
    },
    async deliveredAttestations () {
      const out: StagedAttestation[] = []
      for (const rec of submittedAttestations.values()) {
        out.push({
          version: 1,
          requestId: rec.answer.requestId,
          answer: rec.answer,
          requesterKey: rec.requesterKey,
          signature: rec.signature,
          stagedAt: rec.stagedAt,
          cursor: rec.cursor
        })
      }
      return out
    },
    async publishDecision (decision) {
      decisionSeq += 1
      const cursor = `d${String(decisionSeq).padStart(6, '0')}`
      decisionNotices.push({
        requestId: decision.requestId,
        status: decision.status,
        challengeNonce: decision.challengeNonce,
        reason: decision.reason,
        cursor
      })
      return cursor
    },
    async close () {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()))
      })
    }
  }
}

// ---------------------------------------------------------------------------
// H. The binding table — three entries, one skipped.
//
// The 'p2p' entry is reserved and skipped; a skipped branch cannot fail a
// wave, and it cannot pass one either. A later plan may flip its mode to
// 'run' and supply a real peer-cluster-backed factory; until then its make is
// never invoked, because a skipped mocha describe never runs its hooks.
// This file imports no peer-cluster transport module at all, and even a
// future green branch here would not be verification for that leg (D-08) —
// the peer-cluster leg stays code-complete, unverified until proven on real
// devices/hosts, independent of what Node or mocha report.
// ---------------------------------------------------------------------------
const CONFORMANCE_BINDINGS: ConformanceCase[] = [
  { label: 'filesystem', mode: 'run', make: makeFilesystemBinding },
  { label: 'rest', mode: 'run', make: makeRestBinding },
  {
    label: 'p2p',
    mode: 'skip',
    make: async () => {
      throw new Error('the peer-cluster binding is not attached here')
    }
  }
]

// ---------------------------------------------------------------------------
// I. The shared body — declared once, inside sentinels.
// ---------------------------------------------------------------------------
// #region SHARED-CONFORMANCE-BODY
export function runAssociationRequestTransportConformance (testCase: ConformanceCase): void {
  const suite = testCase.mode === 'skip' ? describe.skip : describe

  suite('association-request transport conformance: ' + testCase.label, () => {
    let issuer: DigestIssuer
    let binding: ConformanceBinding

    beforeEach(async () => {
      // Construction happens HERE, never at describe registration time, so
      // the skipped p2p branch's factory is never invoked.
      issuer = createDigestIssuer()
      binding = await testCase.make(issuer)
    })

    afterEach(async () => {
      await binding.close()
    })

    it('submitRequest round-trips: a staged request is readable with init.submittedAt byte-identical to what was submitted', async () => {
      const signer = makeRealSigner()
      const wrappedSign = async (digest: Uint8Array): Promise<Signature> => await signer.sign(digest)
      const init = makeInit(signer.publicHex)

      const returnedId = await binding.transport.submitRequest(init, signer.publicHex, wrappedSign)
      expect(returnedId).to.equal(init.id)

      const delivered = await binding.deliveredRequests()
      expect(delivered).to.have.lengthOf(1)
      const record = delivered[0]!
      expect(record.requestId).to.equal(init.id)
      expect(record.init.submittedAt).to.equal(init.submittedAt)
      expect(record.requesterKey).to.equal(signer.publicHex)

      const verification = secp256k1.verify(
        hexToBytes(record.signature.signature),
        computeCanonicalRequestDigest(record.init, record.requesterKey).digest,
        hexToBytes(record.requesterKey)
      )
      expect(verification, 'the delivered signature must verify against the digest the receiving side issued').to.equal(true)
    })

    it('submitAttestation round-trips SEPARATELY: a staged attestation is readable, and does NOT appear in readStagedRequests', async () => {
      const signer = makeRealSigner()
      const answer = makeAttestationAnswer()

      await binding.transport.submitAttestation(answer, signer.publicHex, async (digest) => await signer.sign(digest))

      const deliveredAttestations = await binding.deliveredAttestations()
      expect(deliveredAttestations).to.have.lengthOf(1)
      const record = deliveredAttestations[0]!
      expect(record.requestId).to.equal(answer.requestId)
      expect(record.answer.nonce).to.equal(answer.nonce)
      expect(record.requesterKey).to.equal(signer.publicHex)

      // D-18: leg 2 has its OWN staged shape. A binding that conflated the
      // two legs would leak an attestation answer into the request read
      // path — this is the direct check that it does not.
      const deliveredRequests = await binding.deliveredRequests()
      expect(deliveredRequests.find((r) => r.requestId === answer.requestId)).to.equal(undefined)
    })

    it('submitAttestation with a never-submitted requestId is accepted by the courier (dumb transit) but preserves requestId verbatim', async () => {
      const signer = makeRealSigner()
      const orphanRequestId = nextRequestId()
      // Deliberately no prior submitRequest() call for orphanRequestId — the
      // courier does not, and must not, validate that a request exists.
      const answer = makeAttestationAnswer({ requestId: orphanRequestId })

      await binding.transport.submitAttestation(answer, signer.publicHex, async (digest) => await signer.sign(digest))

      const deliveredAttestations = await binding.deliveredAttestations()
      const record = deliveredAttestations.find((r) => r.requestId === orphanRequestId)
      expect(record, 'an attestation answer for an unknown request must still be delivered — the courier does not gate on existence').to.not.equal(undefined)
      // Distinguishable downstream: the requestId survives verbatim, so an
      // authority-side reader can itself decide the request is unknown
      // rather than the courier silently dropping or rewriting it.
      expect(record!.requestId).to.equal(orphanRequestId)
      expect(record!.answer.requestId).to.equal(orphanRequestId)
    })

    it("pollDecisions returns a 'c' notice carrying challengeNonce, and an 'a' notice carrying none", async () => {
      const challengeRequestId = nextRequestId()
      const associatedRequestId = nextRequestId()
      const nonce = `conf-challenge-nonce-${Date.now()}`

      await binding.publishDecision({ requestId: challengeRequestId, status: 'c', challengeNonce: nonce })
      await binding.publishDecision({ requestId: associatedRequestId, status: 'a' })

      const notices = await binding.transport.pollDecisions()
      const challengeNotice = notices.find((n) => n.requestId === challengeRequestId)
      const associatedNotice = notices.find((n) => n.requestId === associatedRequestId)
      expect(challengeNotice, 'challenge-issued notice must be present').to.not.equal(undefined)
      expect(associatedNotice, 'associated notice must be present').to.not.equal(undefined)
      expect(challengeNotice!.status).to.equal('c')
      expect(challengeNotice!.challengeNonce).to.equal(nonce)
      expect(associatedNotice!.status).to.equal('a')
      expect(associatedNotice!.challengeNonce).to.equal(undefined)
    })

    it("pollDecisions THROWS on a notice whose status is outside {'p','c','a','r'} — never a silent skip", async () => {
      const badRequestId = nextRequestId()
      // The WRITE side (publishDecision) is deliberately loosely typed here
      // (see ConformanceBinding's own comment) so this case can drive an
      // out-of-vocabulary status through it; the READ side (pollDecisions)
      // is what must reject it.
      await binding.publishDecision({ requestId: badRequestId, status: 'x' })

      let thrown: unknown
      try {
        await binding.transport.pollDecisions()
      } catch (err) {
        thrown = err
      }
      expect(thrown, 'pollDecisions must throw rather than silently skip an unknown status code').to.not.equal(undefined)
      expect(thrown).to.be.instanceOf(Error)
    })

    it('pollDecisions is safe to call with a stale cursor: re-delivery is permitted, loss is not', async () => {
      const firstId = nextRequestId()
      const secondId = nextRequestId()
      const thirdId = nextRequestId()
      const firstCursor = await binding.publishDecision({ requestId: firstId, status: 'a' })
      const secondCursor = await binding.publishDecision({ requestId: secondId, status: 'a' })
      const thirdCursor = await binding.publishDecision({ requestId: thirdId, status: 'a' })

      const all = await binding.transport.pollDecisions()
      expect(all.map((n) => n.requestId)).to.deep.equal([firstId, secondId, thirdId])
      expect(
        firstCursor < secondCursor && secondCursor < thirdCursor,
        'cursors must be strictly increasing (plain string comparison, which the zero-padded format exists to make valid)'
      ).to.equal(true)

      const afterFirst = await binding.transport.pollDecisions(firstCursor)
      expect(afterFirst.map((n) => n.requestId)).to.deep.equal([secondId, thirdId])

      const afterThird = await binding.transport.pollDecisions(thirdCursor)
      expect(afterThird).to.deep.equal([])

      // Duplicate delivery is permitted, loss is not: a silently dropped
      // decision is a request nobody ever acts on, with no signal anywhere.
      const repeatA = await binding.transport.pollDecisions(firstCursor)
      const repeatB = await binding.transport.pollDecisions(firstCursor)
      expect(repeatA.length).to.be.greaterThan(0)
      expect(repeatA).to.deep.equal(repeatB)
    })

    it('a completed Signature (never a callback, never a private key) crosses the seam intact on BOTH legs', async () => {
      const signer = makeRealSigner()

      // --- leg 1: submitRequest with an ALREADY-RESOLVED Signature ---------
      const init = makeInit(signer.publicHex)
      const requestDigest = computeCanonicalRequestDigest(init, signer.publicHex).digest
      const preResolvedRequestSignature = await signer.sign(requestDigest)
      await binding.transport.submitRequest(init, signer.publicHex, preResolvedRequestSignature)
      const deliveredRequest = (await binding.deliveredRequests()).find((r) => r.requestId === init.id)
      expect(deliveredRequest, 'submission via a pre-resolved Signature must still be delivered').to.not.equal(undefined)
      expect(deliveredRequest!.signature).to.deep.equal(preResolvedRequestSignature)

      // --- leg 2: submitAttestation with an ALREADY-RESOLVED Signature -----
      const answer = makeAttestationAnswer()
      const attestationDigest = computeCanonicalAttestationDigest(answer).digest
      const preResolvedAttestationSignature = await signer.sign(attestationDigest)
      await binding.transport.submitAttestation(answer, signer.publicHex, preResolvedAttestationSignature)
      const deliveredAttestation = (await binding.deliveredAttestations()).find((r) => r.requestId === answer.requestId)
      expect(deliveredAttestation, 'submission via a pre-resolved Signature must still be delivered').to.not.equal(undefined)
      expect(deliveredAttestation!.signature).to.deep.equal(preResolvedAttestationSignature)

      // Neither leg needed a signing CALLBACK, and neither leg ever saw
      // `signer.privateHex` — the private key stayed in this test's own
      // process memory throughout (D-01/D-08).
    })
  })
}
// #endregion SHARED-CONFORMANCE-BODY

for (const testCase of CONFORMANCE_BINDINGS) runAssociationRequestTransportConformance(testCase)

// ---------------------------------------------------------------------------
// Structural gates. These read THIS FILE's own source text (and, for gate
// three, the filesystem binding's source), so the three properties that make
// this suite meaningful — the body is shared, the peer-cluster slot is
// reserved and skipped, and both bindings route through one intake
// declaration and one digest issuer — are permanent regression tests rather
// than paragraphs someone has to remember to read. Located relative to the
// workspace root (walking up from process.cwd() for a directory containing
// both package.json and .git), not relative to an assumed working
// directory, so these gates pass whether mocha is invoked from the repo
// root or from this package's own directory.
// ---------------------------------------------------------------------------
function findRepoRoot (startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('findRepoRoot: reached the filesystem root without finding a directory containing both package.json and .git')
}

const REPO_ROOT = findRepoRoot(process.cwd())
const THIS_FILE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'test', 'association-request-transport-conformance.spec.ts')
const FILESYSTEM_BINDING_SOURCE_PATH = join(
  REPO_ROOT, 'packages', 'vote-engine', 'src', 'association', 'transport', 'filesystem-association-transport.ts'
)

// These gates read THIS FILE's own source text, so every marker string they
// search for is built via concatenation rather than written as one
// contiguous literal — otherwise the gate's OWN source line would itself be
// counted as an extra occurrence of the very marker it is trying to count
// (the same self-collision class recorded in 48-09/48-10's SUMMARYs for
// their grep gates, and in 48-13's own structural gates). Concatenation is a
// correctness requirement here, not a style choice.
const REGION_START_MARKER = '// #' + 'region SHARED-CONFORMANCE-BODY'
const REGION_END_MARKER = '// #' + 'endregion SHARED-CONFORMANCE-BODY'
const CONFORMANCE_FN_NAME = 'runAssociationRequestTransportConf' + 'ormance'
const CREATE_ISSUER_FN_TEXT = 'function ' + 'createDigestIssuer'
const VOTE_ENGINE_BARREL_SPECIFIER = '@votetorrent' + '/vote-engine'
const FORBIDDEN_PEER_CLUSTER_TERMS = [
  'p2p-association' + '-transport',
  'Cadre' + 'Node',
  'str' + 'and',
  'optimys' + 'tic',
  'db-' + 'p2p'
]
const INTAKE_INTERFACE_DECLARATION_TEXT = 'export interface I' + 'AssociationRequestIntake'

describe('association-request transport conformance: structure', () => {
  const thisFileSource = readFileSync(THIS_FILE_PATH, 'utf8')

  it('declares the conformance body exactly once and shares it across every binding', () => {
    // D-08's claim is that the implementations are INTERCHANGEABLE, and the
    // only evidence for interchangeability is that the SAME assertions ran
    // against both. Two copied bodies that happen to agree today prove
    // nothing tomorrow; seven literals producing fourteen passing tests is
    // what makes "shared" mechanically true, not aspirational.
    const start = thisFileSource.indexOf(REGION_START_MARKER)
    const end = thisFileSource.indexOf(REGION_END_MARKER)
    expect(start).to.be.greaterThan(-1)
    expect(end).to.be.greaterThan(start)
    expect(thisFileSource.split(REGION_START_MARKER).length - 1).to.equal(1)
    expect(thisFileSource.split(REGION_END_MARKER).length - 1).to.equal(1)

    const region = thisFileSource.slice(start, end)
    expect((region.match(/\bit\s*\(/g) ?? []).length).to.equal(7)
    expect((thisFileSource.match(/\bit\s*\(/g) ?? []).length).to.equal(10)
    expect(thisFileSource.split(CONFORMANCE_FN_NAME).length - 1).to.equal(2)

    // D-18: no branching on payload shape / binding identity inside the
    // shared body — the exact blurring D-18's rejected alternative
    // (a widened submitRequest with an optional payload) would have caused.
    expect(/testCase\.label\s*===/.test(region)).to.equal(false)
    expect(/binding\.label\s*===/.test(region)).to.equal(false)
    expect(/label\s*===\s*'filesystem'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'rest'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'p2p'/.test(region)).to.equal(false)
    expect(/payload\.kind\s*===/.test(region)).to.equal(false)
    expect(/instanceof\s+(FilesystemAssociationTransport|RestAssociationTransport)/.test(region)).to.equal(false)
  })

  it('reserves the peer-cluster slot as skipped rather than absent, and claims nothing for it', () => {
    // A skipped branch cannot fail a wave and it cannot pass one either; a
    // later plan may flip the entry's mode and supply a real factory, and
    // even then Node and mocha results are not verification for that leg
    // (D-08 mirrors Phase 48 D-11's framing — this project has repeatedly
    // had "implemented but unproven" read as "done"). A later reader must
    // not "fix" the skip by deleting it or flipping it early.
    expect(/label:\s*'p2p'/.test(thisFileSource)).to.equal(true)
    expect(/mode:\s*'skip'/.test(thisFileSource)).to.equal(true)
    expect((thisFileSource.match(/describe\.skip/g) ?? []).length).to.equal(1)
    expect((thisFileSource.match(/\bit\.skip\s*\(/g) ?? []).length).to.equal(0)
    expect((thisFileSource.match(/\.only\(/g) ?? []).length).to.equal(0)
    expect(thisFileSource.includes('cannot fail a wave, and it cannot pass one either')).to.equal(true)
    expect(thisFileSource.includes('code-complete, unverified')).to.equal(true)
    for (const term of FORBIDDEN_PEER_CLUSTER_TERMS) {
      expect(
        thisFileSource.toLowerCase().includes(term.toLowerCase()),
        `this plan must import no peer-cluster transport module: found forbidden term ${term}`
      ).to.equal(false)
    }
  })

  it('routes both bindings through one intake declaration and one shared digest issuer', () => {
    // Two declarations of the same interface name let two bindings satisfy
    // DIFFERENT contracts while appearing to satisfy one — precisely the
    // failure D-08's one-suite/two-bindings requirement exists to prevent.
    // Sharing one digest issuer is the same discipline applied to bytes
    // rather than to types.
    for (const typeName of ['IAssociationRequestIntake', 'StagedAssociationRequest', 'StagedAttestation', 'AssociationDecisionDocument']) {
      expect(
        new RegExp(`(interface|type)\\s+${typeName}\\b`).test(thisFileSource),
        `must not re-declare ${typeName} (imported from the filesystem binding's single declaration)`
      ).to.equal(false)
    }
    expect(thisFileSource.includes("from '../src/association/transport/filesystem-association-transport.js'")).to.equal(true)
    expect(thisFileSource.includes("from '../src/association/transport/rest-association-transport.js'")).to.equal(true)
    expect(thisFileSource.includes(VOTE_ENGINE_BARREL_SPECIFIER)).to.equal(false)
    expect((thisFileSource.match(/REQUEST_DIGEST_FIELD_ORDER\s*=\s*Object\.freeze/g) ?? []).length).to.equal(1)
    expect((thisFileSource.match(/ATTESTATION_DIGEST_FIELD_ORDER\s*=\s*Object\.freeze/g) ?? []).length).to.equal(1)
    expect(thisFileSource.split(CREATE_ISSUER_FN_TEXT).length - 1).to.equal(1)
    expect(/submittedAt\s*[:=]\s*(new Date|toIso|nowCanonical|Date\.now)/.test(thisFileSource)).to.equal(false)

    const filesystemSource = readFileSync(FILESYSTEM_BINDING_SOURCE_PATH, 'utf8')
    expect(filesystemSource.includes(INTAKE_INTERFACE_DECLARATION_TEXT)).to.equal(true)
  })
})
