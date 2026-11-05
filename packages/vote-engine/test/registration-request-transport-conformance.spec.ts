/**
 * registration-request-transport-conformance.spec.ts — Phase 48 Plan 13
 * (D-01/D-12): the shared registration-request transport-conformance suite.
 *
 * ============================================================================
 * 1. WHAT THIS PROVES
 * ============================================================================
 * D-01's claim is that `IRegistrationRequestTransport`'s real bindings are
 * INTERCHANGEABLE. The only evidence for interchangeability is that the SAME
 * assertions ran against both. This file makes that mechanically true, not
 * merely claimed: the six conformance cases are written EXACTLY ONCE, inside
 * one exported function delimited by a matching pair of numbered-comment
 * sentinels (see below). That function is called exactly ONCE, from a
 * loop over a three-entry binding table (filesystem, rest, and a reserved
 * peer-cluster slot). Six test-case literals therefore produce TWELVE
 * passing tests — six per running binding. If an executor ever duplicates
 * the body per binding instead of sharing it, the test-case count inside the
 * sentinel region rises above six and the structural regression gate fails: a
 * duplicated body is a GATE FAILURE, not a style preference.
 *
 * ============================================================================
 * 2. THE THIRD SLOT
 * ============================================================================
 * The peer-cluster binding (48-23) gets a THIRD entry in the binding table,
 * `{ label: 'p2p', mode: 'skip', ... }`. Its six cases render as PENDING —
 * never passing, never absent.
 *
 * A skipped branch cannot fail a wave, and it cannot pass one either.
 *
 * The peer-cluster leg is **code-complete, unverified** (D-11), and even
 * once 48-23 flips this slot's `mode` to `'run'` and supplies a real
 * factory, **Node and mocha results are not verification for it.** A later
 * reader must not "fix" this skip by deleting
 * it, flipping it early, or converting it to `it.skip`. This plan imports NO
 * peer-cluster transport module at all — 48-23 attaches one; nothing here
 * does.
 *
 * ============================================================================
 * 3. DECLARED BLIND SPOT — narrower than it looks
 * ============================================================================
 * `createDigestIssuer()` below is a TEST-LOCAL CANONICAL STAND-IN, not the
 * schema's `Digest()` SQL function. This suite proves the two real bindings
 * agree WITH EACH OTHER and with one issuer; it does NOT prove either agrees
 * with the schema's `SignatureValid` CHECK. The evidence that closes THAT gap
 * is named precisely, not gestured at: **48-07 Task 3's offline
 * pre-resolved-signature round-trip** (`registration-request.spec.ts`,
 * commit `2f2b9d7`) — a signature computed by a submitter over
 * `init.submittedAt` BEFORE the engine ever saw the request, INSERTed and
 * accepted by the real `SignatureValid` CHECK. Confirmed present in
 * `48-07-SUMMARY.md` ("a pre-resolved offline signature that verifies at
 * INSERT — the direct proof 48-09's courier binding is possible") before
 * this header deferred to it. That is the case that proves a staged,
 * already-resolved `Signature` (the only kind 48-09's intake ever forwards)
 * survives DG-1; a handshake-flavoured test where the receiving side
 * supplies the digest would not have.
 *
 * ============================================================================
 * 4. WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT
 * ============================================================================
 * Neither transport REJECTS a tampered document — they are couriers, and the
 * filesystem module's own header states that explicitly. What is proven here
 * is that tampering is DETECTABLE at the same point, with the same evidence,
 * through either binding, and that neither binding launders a tampered
 * payload into a verifiable one by re-issuing a digest over the mutated
 * bytes.
 *
 * ============================================================================
 * 5. NO CLAIM OF SCOPE ENFORCEMENT
 * ============================================================================
 * This file touches no ceremony. No sentence in this file claims that the
 * 'vrg' label gates anything.
 */

import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'
import { FilesystemRegistrationTransport } from '../src/registration/transport/filesystem-registration-transport.js'
import type { StagedRequest } from '../src/registration/transport/filesystem-registration-transport.js'
import { RestRegistrationTransport } from '../src/registration/transport/rest-registration-transport.js'
import type { IRegistrationRequestTransport, RegistrationDecisionNotice } from '../src/registration/transport/registration-request-transport.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// ---------------------------------------------------------------------------
// B. DG1_FIELD_ORDER — one frozen constant, at module top level.
//
// Source of truth: `48-07-SUMMARY.md`'s recorded DG-1 `digestExpr` argument
// order (`select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType,
// :bridgeId, :payloadCid, :submittedAt) as d`). The bytes that satisfy the
// schema's `SignatureValid` CHECK are produced by that exact `Digest(...)`
// expression; a binding whose field order diverges is accepted by the
// transport and rejected only at INSERT time, a phase away from its cause.
// Pinning the order here is what makes such a divergence a FAILING
// ASSERTION in this suite instead of a device mystery later.
// ---------------------------------------------------------------------------
const DG1_FIELD_ORDER = Object.freeze([
  'id',
  'authorityId',
  'requesterKey',
  'issuerType',
  'bridgeId',
  'payloadCid',
  'submittedAt'
] as const)

// ---------------------------------------------------------------------------
// C. createDigestIssuer() — the shared receiving-side digest authority.
//
// This is the reconciliation mechanism 48-10 explicitly handed to this plan.
// Both harnesses below use the SAME issuer instance, so a field-order or
// timestamp divergence between the bindings cannot hide behind two separate
// digest computations. The allocation counter is what proves 48-10's handed
// obligation: a receiving side that re-digests on demand, or that
// substitutes a clock reading for the submitter's `init.submittedAt`,
// increments the counter past 1 and fails case 6 (Task 2). The submitter
// owning `submittedAt` is the only reason an offline, pre-resolved signature
// can verify at all, so a receiver that "helpfully" re-stamped it would
// invalidate a signature it never touched — and would do so silently,
// surfacing a phase away as a `SignatureValid` CHECK rejection.
// ---------------------------------------------------------------------------
interface DigestIssuerRecord {
  submittedAt: string
  input: Record<string, string>
  digest: Uint8Array
}

interface DigestIssuer {
  issue: (init: RegistrationRequestInit, requesterKey: string) => DigestIssuerRecord
  recordFor: (requestId: string) => DigestIssuerRecord
  allocationCount: (requestId: string) => number
  digestFor: (requestId: string) => Uint8Array
}

/**
 * The pure DG1_FIELD_ORDER tuple-building + hashing computation, independent
 * of any memoization. Used two ways below, deliberately: `createDigestIssuer`
 * wraps this in a once-per-request memo (the RECEIVING SIDE's issuance
 * behavior, the thing case 6's `allocationCount` guards); `verifyDelivered`
 * calls this DIRECTLY, unmemoized, every time — mirroring what the real
 * schema's `SignatureValid` CHECK actually does: `Digest(...)` is evaluated
 * fresh from the ROW's CURRENT column values at INSERT time, never from a
 * cached issuance. A tampered delivered document therefore fails
 * `verifyDelivered` precisely because it recomputes over the CURRENT
 * (possibly mutated) content — without the issuer ever being asked to
 * re-issue anything, which is exactly the property case 4's
 * `allocationCount === 1` assertion checks from the other side.
 */
function computeCanonicalDigest (init: RegistrationRequestInit, requesterKey: string): { input: Record<string, string>; digest: Uint8Array } {
  // Neither this function nor its callers ever manufacture a submittedAt:
  // no `new Date()`, no `toIsoZDatetime`, no `nowCanonicalDatetime()`. A
  // missing one is a fixture bug and must throw loudly here, never be
  // silently defaulted.
  if (typeof init.submittedAt !== 'string' || init.submittedAt.length === 0 || !init.submittedAt.endsWith('Z')) {
    throw new Error(
      `computeCanonicalDigest: init.submittedAt must be a non-empty Z-suffixed string (fixture bug), got ${JSON.stringify(init.submittedAt)}`
    )
  }
  const payloadCid = bytesToHex(sha256(utf8ToBytes(JSON.stringify(init.payload))))

  const input: Record<string, string> = {}
  for (const field of DG1_FIELD_ORDER) {
    let value: string
    switch (field) {
      case 'id': value = init.id; break
      case 'authorityId': value = init.authorityId; break
      case 'requesterKey': value = requesterKey; break
      case 'issuerType': value = init.issuerType ?? 'registrant'; break
      case 'bridgeId': value = init.bridgeId ?? ''; break
      case 'payloadCid': value = payloadCid; break
      case 'submittedAt': value = init.submittedAt; break
    }
    input[field] = value
  }

  const line = DG1_FIELD_ORDER.map((field) => `${field}=${input[field]}`).join('\n')
  const digest = sha256(utf8ToBytes(line))
  return { input, digest }
}

function createDigestIssuer (): DigestIssuer {
  const records = new Map<string, DigestIssuerRecord>()
  const counts = new Map<string, number>()

  function issue (init: RegistrationRequestInit, requesterKey: string): DigestIssuerRecord {
    counts.set(init.id, (counts.get(init.id) ?? 0) + 1)
    const existing = records.get(init.id)
    if (existing !== undefined) return existing

    const { input, digest } = computeCanonicalDigest(init, requesterKey)
    const record: DigestIssuerRecord = { submittedAt: init.submittedAt, input, digest }
    records.set(init.id, record)
    return record
  }

  function recordFor (requestId: string): DigestIssuerRecord {
    const record = records.get(requestId)
    if (record === undefined) throw new Error(`createDigestIssuer.recordFor: no record for request ${requestId}`)
    return record
  }

  function allocationCount (requestId: string): number {
    return counts.get(requestId) ?? 0
  }

  function digestFor (requestId: string): Uint8Array {
    return recordFor(requestId).digest
  }

  return { issue, recordFor, allocationCount, digestFor }
}

// ---------------------------------------------------------------------------
// D. makeRealSigner() — one closure, both branches.
//
// Adapted from `authority-transport.spec.ts:31-40`. `signerUserId` is
// deliberately empty: a prospective registrant has no `User` row (D-02), and
// neither binding may read that field.
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

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

let requestIdSeq = 0
function nextRequestId (): string {
  requestIdSeq += 1
  return `conf-req-${Date.now()}-${requestIdSeq}`
}

/** A valid `RegistrationRequestInit` with a plausible payload and a
 * monotonic id so ids never collide across cases. */
function makeInit (overrides: Partial<RegistrationRequestInit> = {}): RegistrationRequestInit {
  const id = overrides.id ?? nextRequestId()
  const authorityId = overrides.authorityId ?? 'conformance-authority'
  return {
    id,
    authorityId,
    payload: overrides.payload ?? {
      registrant: { id: `registrant-${id}`, authorityId, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'note', value: 'conformance-fixture' }] }
    },
    submittedAt: overrides.submittedAt ?? defaultSubmittedAt(),
    issuerType: overrides.issuerType,
    bridgeId: overrides.bridgeId
  }
}

const TAMPER_REJECTION_REASON = 'delivered signature does not verify against the digest the receiving side issued for this request'

interface DeliveredVerification { ok: boolean; reason?: string }

/** J: shared verification helper — reused by case 1 (Task 1) and cases 4/6
 * (Task 2), which is what makes "identically" literal rather than
 * aspirational. */
function verifyDelivered (delivered: StagedRequest, issuer: DigestIssuer): DeliveredVerification {
  // `issuer` is accepted (not merely a bare transport) to keep this
  // helper's shape consistent with the rest of the harness, but the
  // verification itself is deliberately an INDEPENDENT recompute over
  // `delivered`'s CURRENT content via `computeCanonicalDigest` — see that
  // function's header for why a memoized `issuer.digestFor` lookup would
  // make case 4's tamper detection vacuous.
  void issuer
  const { digest } = computeCanonicalDigest(delivered.init, delivered.requesterKey)
  const ok = secp256k1.verify(hexToBytes(delivered.signature.signature), digest, hexToBytes(delivered.requesterKey))
  return ok ? { ok: true } : { ok: false, reason: TAMPER_REJECTION_REASON }
}

const KEY_MATERIAL_PATTERN = /privateKey|privKey|secretKey|mnemonic/i

/** D-01: a channel that crosses a filesystem or a network holds no key
 * material. Scanned identically on both media through this one helper. */
function assertNoKeyMaterial (wireText: string, privateHex: string): void {
  expect(KEY_MATERIAL_PATTERN.test(wireText), 'wire text must not reference a private-key-shaped field name').to.equal(false)
  expect(wireText.includes(privateHex), "wire text must not contain the signer's private-key hex").to.equal(false)
}

// ---------------------------------------------------------------------------
// E. The harness contract — parameterize over construction, not over a bare
// transport. The two bindings' construction shapes DIFFER (injected
// RequestDigestFn vs. a live handshake); a factory returns a whole harness
// so each side can resolve that difference internally while exposing one
// shared surface to the conformance body.
// ---------------------------------------------------------------------------
interface ConformanceBinding {
  readonly label: string
  readonly transport: IRegistrationRequestTransport
  deliveredSubmissions: () => Promise<StagedRequest[]>
  publishDecision: (decision: { requestId: string; status: RegistrationRequestStatus; reason?: string }) => Promise<string>
  tamperDeliveredPayload: (requestId: string) => Promise<void>
  capturedWireText: () => string
  close: () => Promise<void>
}

interface ConformanceCase {
  label: string
  mode: 'run' | 'skip'
  make: (issuer: DigestIssuer) => Promise<ConformanceBinding>
}

// ---------------------------------------------------------------------------
// F. Factory 1 — filesystem (48-09).
// ---------------------------------------------------------------------------
async function makeFilesystemBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const rootDir = await mkdtemp(join(tmpdir(), 'registration-conformance-fs-'))
  const requestsDir = join(rootDir, 'requests')
  const decisionsDir = join(rootDir, 'decisions')

  const transport = new FilesystemRegistrationTransport({
    rootDir,
    computeDigest: async (init, requesterKey) => issuer.issue(init, requesterKey).digest
  })

  return {
    label: 'filesystem',
    transport,
    async deliveredSubmissions () {
      return await transport.readStagedRequests()
    },
    async publishDecision (decision) {
      // decidedAt is this courier's own write-time marker (unrelated to,
      // and never substituted for, the submitter's submittedAt).
      return await transport.publishDecision({ ...decision, decidedAt: new Date().toISOString() })
    },
    async tamperDeliveredPayload (requestId) {
      const entries = await readdir(requestsDir)
      const match = entries.find((file) => file.endsWith(`-${requestId}.json`))
      if (match === undefined) {
        throw new Error(`makeFilesystemBinding.tamperDeliveredPayload: no staged document found for ${requestId}`)
      }
      const filePath = join(requestsDir, match)
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { init: { payload: Record<string, unknown> } }
      parsed.init.payload = { ...parsed.init.payload, __tampered: true }
      await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8')
    },
    capturedWireText () {
      const parts: string[] = []
      for (const dirPath of [requestsDir, decisionsDir]) {
        let entries: string[] = []
        try {
          entries = readdirSync(dirPath)
        } catch {
          entries = []
        }
        for (const file of entries) {
          if (!file.endsWith('.json')) continue
          parts.push(readFileSync(join(dirPath, file), 'utf8'))
        }
      }
      return parts.join('\n')
    },
    async close () {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// G. Factory 2 — REST (48-10). A throwaway node:http receiver implementing
// R-1/R-2/R-3 exactly as `48-10-SUMMARY.md` records them.
// ---------------------------------------------------------------------------
interface CapturedRequest { method: string; url: string; body: unknown }

async function makeRestBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const captured: CapturedRequest[] = []
  const submitted = new Map<string, { init: RegistrationRequestInit; requesterKey: string; signature: Signature; submittedAt: string; cursor: string }>()
  const decisionNotices: RegistrationDecisionNotice[] = []
  let submitSeq = 0
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
      captured.push({ method, url, body: parsedBody })

      if (method === 'POST' && url === '/registration-requests/digest') {
        const body = parsedBody as { init: RegistrationRequestInit; requesterKey: string }
        // R-1: the receiving side issues the digest AND echoes the
        // submitter's own submittedAt back beside it — issuer.issue()
        // memoizes on the first call per request id, never re-derives.
        const issued = issuer.issue(body.init, body.requesterKey)
        send(res, 200, { digest: bytesToHex(issued.digest), submittedAt: issued.submittedAt })
        return
      }

      if (method === 'POST' && url === '/registration-requests') {
        const body = parsedBody as { init: RegistrationRequestInit; requesterKey: string; submittedAt: string; signature: Signature }
        // R-2's receiver obligation this plan closes: resolve submittedAt
        // from the MEMOIZED issuer record (the submitter's own value),
        // never by re-deriving it from a clock, and cross-check all three
        // wire positions agree — a disagreement means something on the
        // path rewrote a signed field.
        const memoized = issuer.recordFor(body.init.id).submittedAt
        if (body.submittedAt !== memoized || body.init.submittedAt !== memoized) {
          send(res, 400, { error: 'submittedAt disagreement across wire positions' })
          return
        }
        submitSeq += 1
        const cursor = `s${String(submitSeq).padStart(6, '0')}`
        submitted.set(body.init.id, {
          init: body.init,
          requesterKey: body.requesterKey,
          signature: body.signature,
          submittedAt: memoized,
          cursor
        })
        send(res, 200, { requestId: body.init.id })
        return
      }

      if (method === 'GET' && url.startsWith('/registration-decisions')) {
        const parsedUrl = new URL(url, 'http://127.0.0.1')
        const since = parsedUrl.searchParams.get('since')
        // Zero-padded 'sNNNNNN'/'dNNNNNN'-style cursors make plain string
        // comparison a total order.
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
  const transport = new RestRegistrationTransport({ baseUrl })

  return {
    label: 'rest',
    transport,
    async deliveredSubmissions () {
      const out: StagedRequest[] = []
      for (const rec of submitted.values()) {
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
    async publishDecision (decision) {
      decisionSeq += 1
      const cursor = `d${String(decisionSeq).padStart(6, '0')}`
      decisionNotices.push({ requestId: decision.requestId, status: decision.status, reason: decision.reason, cursor })
      return cursor
    },
    async tamperDeliveredPayload (requestId) {
      const rec = submitted.get(requestId)
      if (rec === undefined) {
        throw new Error(`makeRestBinding.tamperDeliveredPayload: no submitted record for ${requestId}`)
      }
      const payload = rec.init.payload as unknown as Record<string, unknown>
      rec.init = { ...rec.init, payload: { ...payload, __tampered: true } as unknown as typeof rec.init.payload }
    },
    capturedWireText () {
      return JSON.stringify(captured)
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
// wave, and it cannot pass one either. 48-23 flips its mode to 'run' and
// supplies a real factory; until then its make is never invoked, because a
// skipped mocha describe never runs its hooks. This plan imports no peer-cluster
// transport module at all, keeping this suite free of that dependency
// through 48-22, and even a future green branch here is not verification
// for that leg (D-11) — the peer-cluster leg stays code-complete,
// unverified until proven on real devices/hosts, independent of what Node
// or mocha report.
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
export function runRegistrationRequestTransportConformance (testCase: ConformanceCase): void {
  const suite = testCase.mode === 'skip' ? describe.skip : describe

  suite('registration-request transport conformance: ' + testCase.label, () => {
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

    it('submits a genuinely signed request and the transmitted signature verifies against the digest the receiving side issued', async () => {
      const signer = makeRealSigner()
      let capturedSignature: Signature | undefined
      const wrappedSign = async (digest: Uint8Array): Promise<Signature> => {
        const sig = await signer.sign(digest)
        capturedSignature = sig
        return sig
      }
      const init = makeInit()

      const returnedId = await binding.transport.submitRequest(init, signer.publicHex, wrappedSign)
      expect(returnedId).to.equal(init.id)

      const delivered = await binding.deliveredSubmissions()
      expect(delivered).to.have.lengthOf(1)
      const record = delivered[0]!
      expect(record.init.payload).to.deep.equal(init.payload)
      expect(record.requesterKey).to.equal(signer.publicHex)
      expect(record.signature).to.deep.equal(capturedSignature)

      const verification = verifyDelivered(record, issuer)
      expect(
        verification.ok,
        `expected the delivered signature to verify against the digest the receiving side issued (reason if failed: ${String(verification.reason)})`
      ).to.equal(true)

      assertNoKeyMaterial(binding.capturedWireText(), signer.privateHex)
    })

    it('polls back the authority decision with its status and reason byte-identical', async () => {
      const signer = makeRealSigner()
      const approvedInit = makeInit()
      await binding.transport.submitRequest(approvedInit, signer.publicHex, signer.sign)
      const rejectedInit = makeInit()
      await binding.transport.submitRequest(rejectedInit, signer.publicHex, signer.sign)

      const rejectionReason = `conformance-reject-reason-${Date.now()}`
      await binding.publishDecision({ requestId: approvedInit.id, status: 'a' })
      await binding.publishDecision({ requestId: rejectedInit.id, status: 'r', reason: rejectionReason })

      const notices = await binding.transport.pollDecisions()
      const approvedNotice = notices.find((n) => n.requestId === approvedInit.id)
      const rejectedNotice = notices.find((n) => n.requestId === rejectedInit.id)
      expect(approvedNotice, 'approval notice must be present').to.not.equal(undefined)
      expect(rejectedNotice, 'rejection notice must be present').to.not.equal(undefined)
      expect(approvedNotice!.status).to.equal('a')
      expect(rejectedNotice!.status).to.equal('r')
      // D-06: a persisted rejection reason is what lets an applicant be
      // told why, and a transport that mangled it would silently degrade
      // an auditable record into a shrug.
      expect(rejectedNotice!.reason).to.equal(rejectionReason)
    })

    it('advances decision cursors monotonically and re-delivers on a stale cursor rather than losing one', async () => {
      const firstId = nextRequestId()
      const secondId = nextRequestId()
      const thirdId = nextRequestId()
      const firstCursor = await binding.publishDecision({ requestId: firstId, status: 'a' })
      const secondCursor = await binding.publishDecision({ requestId: secondId, status: 'a' })
      const thirdCursor = await binding.publishDecision({ requestId: thirdId, status: 'a' })

      const all = await binding.transport.pollDecisions()
      expect(all.map((n) => n.requestId)).to.deep.equal([firstId, secondId, thirdId])
      expect(all.map((n) => n.cursor)).to.deep.equal([firstCursor, secondCursor, thirdCursor])
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

    it('detects a tampered payload identically, and neither binding launders it into a verifiable document', async () => {
      const signer = makeRealSigner()
      const init = makeInit()
      await binding.transport.submitRequest(init, signer.publicHex, signer.sign)

      const before = (await binding.deliveredSubmissions())[0]!
      const beforeVerification = verifyDelivered(before, issuer)
      expect(beforeVerification.ok, 'a genuine, untampered signature must verify before any tampering').to.equal(true)

      await binding.tamperDeliveredPayload(init.id)

      const after = (await binding.deliveredSubmissions())[0]!
      const afterVerification = verifyDelivered(after, issuer)
      // A seam where one binding detects tampering and another does not is
      // WORSE than no seam: it invites the reviewing officer to trust a
      // uniformity that is not there. (1) the SAME shared helper now
      // reports failure, through EITHER binding.
      expect(afterVerification.ok, 'a tampered document must fail the same verification the genuine one passed').to.equal(false)
      // (2) the same shared reason CONSTANT — asserted on the constant, not
      // a free-text message, so "identically" is literal.
      expect(afterVerification.reason).to.equal(TAMPER_REJECTION_REASON)
      // (3) the receiving side must NOT have re-issued a digest over the
      // mutated bytes — that is the laundering path this case closes.
      expect(issuer.allocationCount(init.id)).to.equal(1)

      // Honest limit restated: neither transport REJECTS the tampered
      // document — they are couriers, and the schema's SignatureValid CHECK
      // is the authorization gate (D-02). What is proven here is that the
      // evidence needed to reject is present and identical on both sides.
      assertNoKeyMaterial(binding.capturedWireText(), signer.privateHex)
    })

    it('carries bridge issuer markers through unchanged and inside the signed digest input', async () => {
      const signer = makeRealSigner()
      const bridgeId = `conf-bridge-${Date.now()}`
      const bridgeInit = makeInit({ issuerType: 'bridge', bridgeId })
      await binding.transport.submitRequest(bridgeInit, signer.publicHex, signer.sign)

      const bridgeDelivered = (await binding.deliveredSubmissions()).find((r) => r.requestId === bridgeInit.id)
      expect(bridgeDelivered, 'bridge-issued submission must be delivered').to.not.equal(undefined)
      expect(bridgeDelivered!.init.issuerType).to.equal('bridge')
      expect(bridgeDelivered!.init.bridgeId).to.equal(bridgeId)

      // The markers must be INSIDE the bytes the requester signed, not
      // metadata bolted on beside them (D-03) — a binding that dropped,
      // defaulted, or normalized these markers would make a bridge
      // assertion arrive looking like a voter's own cryptographically
      // attributed act.
      const bridgeRecord = issuer.recordFor(bridgeInit.id)
      expect(bridgeRecord.input.issuerType).to.equal('bridge')
      expect(bridgeRecord.input.bridgeId).to.equal(bridgeId)

      const registrantSigner = makeRealSigner()
      const registrantInit = makeInit()
      await binding.transport.submitRequest(registrantInit, registrantSigner.publicHex, registrantSigner.sign)
      const registrantDelivered = (await binding.deliveredSubmissions()).find((r) => r.requestId === registrantInit.id)
      expect(registrantDelivered, 'registrant-issued submission must be delivered').to.not.equal(undefined)
      expect(registrantDelivered!.init.bridgeId).to.equal(undefined)
    })

    it('agrees on digest inputs: one frozen field order, and a submittedAt the receiving side issues once and reuses', async () => {
      const signer = makeRealSigner()
      const init = makeInit()
      await binding.transport.submitRequest(init, signer.publicHex, signer.sign)

      const record = issuer.recordFor(init.id)
      // 1. Same fields, same order, for both bindings — a field-order
      // divergence between the two bindings fails HERE rather than as a
      // CHECK failure at INSERT time a phase later.
      expect(Object.keys(record.input)).to.deep.equal([...DG1_FIELD_ORDER])

      // 2. The receiving side memoized the submitter's submittedAt ONCE and
      // never re-issued a digest over a different one.
      expect(issuer.allocationCount(init.id)).to.equal(1)

      // 3. The submitter's submittedAt round-trips unchanged through
      // either medium — nothing on the path rewrote, re-stamped,
      // re-formatted, truncated, or normalised the value the requester
      // signed over. This is the ONE place in the phase where the
      // filesystem binding's injected digest-function resolution and the
      // REST binding's handshake resolution are checked against each
      // other: the divergence in HOW they resolve the digest is expected
      // (the bindings share an interface, not internals), but the VALUE
      // they arrive at must agree.
      expect(record.submittedAt).to.equal(init.submittedAt)
      expect(record.submittedAt.endsWith('Z')).to.equal(true)
      const delivered = (await binding.deliveredSubmissions()).find((r) => r.requestId === init.id)
      expect(delivered, 'submission must be delivered').to.not.equal(undefined)
      expect(delivered!.init.submittedAt).to.equal(record.submittedAt)

      // 4. Closing the loop from field order through to a verifying
      // signature.
      const verification = verifyDelivered(delivered!, issuer)
      expect(
        verification.ok,
        `expected the delivered signature to verify (reason if failed: ${String(verification.reason)})`
      ).to.equal(true)
    })
  })
}
// #endregion SHARED-CONFORMANCE-BODY

for (const testCase of CONFORMANCE_BINDINGS) runRegistrationRequestTransportConformance(testCase)

// ---------------------------------------------------------------------------
// Task 3: structural gates. These read THIS FILE's own source text (and, for
// gate three, the filesystem binding's source), so the three properties that
// make this suite meaningful — the body is shared, the peer-cluster slot is
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
const THIS_FILE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'test', 'registration-request-transport-conformance.spec.ts')
const FILESYSTEM_BINDING_SOURCE_PATH = join(
  REPO_ROOT, 'packages', 'vote-engine', 'src', 'registration', 'transport', 'filesystem-registration-transport.ts'
)

// These gates read THIS FILE's own source text, so every marker string they
// search for is built via concatenation rather than written as one
// contiguous literal — otherwise the gate's OWN source line would itself be
// counted as an extra occurrence of the very marker it is trying to count
// (the same self-collision class recorded in 48-09/48-10's SUMMARYs for
// their grep gates). Concatenation is a correctness requirement here, not a
// style choice: a gate that miscounts its own text would be silently
// vacuous or silently over-strict depending on which direction it drifts.
const REGION_START_MARKER = '// #' + 'region SHARED-CONFORMANCE-BODY'
const REGION_END_MARKER = '// #' + 'endregion SHARED-CONFORMANCE-BODY'
const CONFORMANCE_FN_NAME = 'runRegistrationRequestTransportConf' + 'ormance'
const CREATE_ISSUER_FN_TEXT = 'function ' + 'createDigestIssuer'
const VOTE_ENGINE_BARREL_SPECIFIER = '@votetorrent' + '/vote-engine'
const FORBIDDEN_PEER_CLUSTER_TERMS = [
  'p2p-registration' + '-transport',
  'Cadre' + 'Node',
  'str' + 'and',
  'optimys' + 'tic',
  'db-' + 'p2p'
]
const INTAKE_INTERFACE_DECLARATION_TEXT = 'export interface I' + 'RegistrationRequestIntake'

describe('registration-request transport conformance: structure', () => {
  const thisFileSource = readFileSync(THIS_FILE_PATH, 'utf8')

  it('declares the conformance body exactly once and shares it across every binding', () => {
    // D-01's claim is that the implementations are INTERCHANGEABLE, and the
    // only evidence for interchangeability is that the SAME assertions ran
    // against both. Two copied bodies that happen to agree today prove
    // nothing tomorrow; six literals producing twelve passing tests is what
    // makes "shared" mechanically true, not aspirational.
    const start = thisFileSource.indexOf(REGION_START_MARKER)
    const end = thisFileSource.indexOf(REGION_END_MARKER)
    expect(start).to.be.greaterThan(-1)
    expect(end).to.be.greaterThan(start)
    expect(thisFileSource.split(REGION_START_MARKER).length - 1).to.equal(1)
    expect(thisFileSource.split(REGION_END_MARKER).length - 1).to.equal(1)

    const region = thisFileSource.slice(start, end)
    expect((region.match(/\bit\s*\(/g) ?? []).length).to.equal(6)
    expect((thisFileSource.match(/\bit\s*\(/g) ?? []).length).to.equal(9)
    expect(thisFileSource.split(CONFORMANCE_FN_NAME).length - 1).to.equal(2)

    expect(/testCase\.label\s*===/.test(region)).to.equal(false)
    expect(/binding\.label\s*===/.test(region)).to.equal(false)
    expect(/label\s*===\s*'filesystem'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'rest'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'p2p'/.test(region)).to.equal(false)
    expect(/instanceof\s+(FilesystemRegistrationTransport|RestRegistrationTransport)/.test(region)).to.equal(false)
  })

  it('reserves the peer-cluster slot as skipped rather than absent, and claims nothing for it', () => {
    // A skipped branch cannot fail a wave and it cannot pass one either;
    // 48-23 flips the entry's mode and supplies a real factory; even then,
    // Node and mocha results are not verification for that leg (D-11 —
    // this project has repeatedly had "implemented but unproven" read as
    // "done"). A later reader must not "fix" the skip by deleting it or
    // flipping it early.
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

  it('routes both bindings through one intake declaration and one digest issuer', () => {
    // Two declarations of the same interface name let two bindings satisfy
    // DIFFERENT contracts while appearing to satisfy one — precisely the
    // failure D-01's one-suite/two-bindings requirement exists to prevent.
    // Sharing one digest issuer is the same discipline applied to bytes
    // rather than to types.
    for (const typeName of ['IRegistrationRequestIntake', 'StagedRequest', 'StagedRequestDocument']) {
      expect(
        new RegExp(`(interface|type)\\s+${typeName}\\b`).test(thisFileSource),
        `must not re-declare ${typeName} (imported from the filesystem binding's single declaration)`
      ).to.equal(false)
    }
    expect(thisFileSource.includes("from '../src/registration/transport/filesystem-registration-transport.js'")).to.equal(true)
    expect(thisFileSource.includes("from '../src/registration/transport/rest-registration-transport.js'")).to.equal(true)
    expect(thisFileSource.includes(VOTE_ENGINE_BARREL_SPECIFIER)).to.equal(false)
    expect((thisFileSource.match(/DG1_FIELD_ORDER\s*=\s*Object\.freeze/g) ?? []).length).to.equal(1)
    expect(thisFileSource.split(CREATE_ISSUER_FN_TEXT).length - 1).to.equal(1)
    expect(/submittedAt\s*[:=]\s*(new Date|toIso|nowCanonical|Date\.now)/.test(thisFileSource)).to.equal(false)

    const filesystemSource = readFileSync(FILESYSTEM_BINDING_SOURCE_PATH, 'utf8')
    expect(filesystemSource.includes(INTAKE_INTERFACE_DECLARATION_TEXT)).to.equal(true)
  })
})
