import type { AssociationAttestationAnswer, AssociationRequestInit, Signature } from '@votetorrent/vote-core'
import type { IAssociationRequestTransport, AssociationDecisionNotice } from './association-request-transport.js'
import { assertKnownAssociationStatus } from './association-request-transport.js'
import { digestToBytes } from '../../utils.js'
import { computeAssociationAttestationDigest, computeAssociationRequestDigest } from './association-request-digest.js'

/**
 * rest-association-transport.ts — the D-08 pull-based REST binding, one of
 * `IAssociationRequestTransport`'s TWO required real bindings (the other is
 * the filesystem drop-file courier, `filesystem-association-transport.ts`).
 * Structural analog:
 * `packages/vote-engine/src/registration/transport/rest-registration-transport.ts` (48-10).
 *
 * **1. PULL BY DESIGN.** This binding only ever calls OUT. The authority
 * polls; it does not host an inbound webhook receiver, and it never binds a
 * port. React Native cannot reliably run a persistent background HTTP
 * listener — there is no long-running server process, the OS drives
 * backgrounding and process-kill semantics on its own schedule, and a NAT'd
 * mobile device has no open inbound port to defend in the first place. An
 * inbound port on such a device is additionally an attack surface with no
 * way to close it.
 *
 * **2. Where a real push receiver would belong, if one is ever wanted:** a
 * small standalone Node service, never inside the app bundle. None is added
 * in this phase.
 *
 * **3. Zero new dependencies.** For transport this file uses only the Node/RN
 * built-in `fetch` and `AbortSignal.timeout`. No promise-based HTTP-client
 * package and no server-side web framework may be added for this file's sake
 * — none exists anywhere in this monorepo today, and adding one for a single
 * JSON round-trip is unwarranted — this codebase has a documented aversion to
 * new React Native bundling risk (Phase 44's `@peculiar` device-boot wall
 * cost two plans to unstick). The one non-transport import,
 * `./association-request-digest.js` (item 8b), pulls in
 * `@optimystic/quereus-plugin-crypto`, which is already a direct dependency
 * of this package and already bundles on device via
 * `verifiers/digest-binding.ts` — it is not a new dependency and adds no new
 * bundling risk.
 *
 * **4. What makes a fetched document trustworthy here.** An `https://`
 * `baseUrl` is the expectation for any real deployment (`http://` is
 * acceptable only for a loopback test server); TLS protects confidentiality
 * and integrity **in transit** and authorizes NOTHING. The only thing that
 * makes a fetched request or attestation document trustworthy is the
 * **requester's own signature over the authority-issued digest**, which the
 * schema's `SignatureValid` CHECK verifies at write time (D-02). A binding
 * that trusted the endpoint instead of the signature would be trusting the
 * network. Certificate validation is the platform `fetch`'s; this file
 * neither disables nor overrides it.
 *
 * **5. The courier rule for `init.submittedAt`.** It is the submitter's own
 * signing-time timestamp and is inside the signed digest the engine will
 * verify at write time (51-01's recorded `SignatureValid` digest order).
 * This binding forwards it **verbatim**: it never generates, defaults,
 * normalises, re-formats, or adopts a server-supplied replacement for it,
 * and it treats the digest handshake's echoed `submittedAt` as a value to
 * *verify*, never a value to *use*. A courier that rewrote it would
 * invalidate a signature it never touched, and the failure would surface at
 * the authority's write — a layer away from its cause.
 *
 * **6. The `SignatureOrCallback` property.** This binding receives a
 * completed `Signature` or a digest→`Signature` callback and NEVER a raw
 * private key, on BOTH legs, so a channel that crosses a network holds no
 * key material (D-01/D-08).
 *
 * **7.** This file touches no ceremony. No sentence here claims the `'vrg'`
 * scope is enforced anywhere.
 *
 * **8. D-18: association is NOT single-round-trip.** `submitAttestation` is
 * a distinct second voter-to-authority message with its OWN digest
 * handshake and its OWN pair of endpoints — never an overload of the
 * request-submission endpoints. Each leg's handshake echoes back the field
 * the requester signed over, and the binding REJECTS a divergence before
 * signing anything: leg 1 checks `submittedAt`, leg 2 checks `requestId` and
 * `nonce`.
 *
 * **8b. THE ECHO CHECKS ARE NOT WHAT STOPS A HOSTILE ENDPOINT (CR-03).** An
 * echo is satisfied by any endpoint that hands back a value out of the very
 * request body it was just given, so on its own it proves NOTHING about the
 * `digest` sitting beside it. What actually stops a hostile or MITM'd
 * endpoint from choosing the 32 bytes the device's HARDWARE key signs is the
 * LOCAL RECOMPUTATION on both legs: `association-request-digest.ts` rebuilds
 * the engine's own digest tuple from values the client already holds, and
 * this binding refuses to sign a handshake digest that does not match it
 * byte for byte. The echo checks are kept because they name the divergence
 * more precisely than a digest mismatch can, but they are a diagnostic, not
 * the control. Never remove the recomputation and leave the echoes in place
 * believing they cover it — an unverified server-chosen digest is a blind
 * signing oracle over the Secure Enclave / StrongBox key.
 *
 * **9. This is the D-17 hardware-ceremony carrier.** This binding is the
 * ONLY viable carrier for a real two-party App Attest / Play Integrity
 * ceremony: an iPhone or an Android device cannot write into a host
 * filesystem directory a Node process reads. The filesystem sibling
 * (`filesystem-association-transport.ts`) imports `node:fs/promises`, is
 * structurally excluded from RN bundling, and has zero references anywhere
 * under `apps/` — it cannot carry D-17. This binding can.
 *
 * **The wire protocol (locked, mirrored by any test-only server exercising
 * this binding):**
 *   - leg 1, R-1 `POST {baseUrl}/association-requests/digest` `{ init, requesterKey }`
 *     → `{ digest, submittedAt }` (`submittedAt` is an ECHO of `init.submittedAt`).
 *   - leg 1, R-2 `POST {baseUrl}/association-requests`
 *     `{ init, requesterKey, submittedAt: init.submittedAt, signature }` → `{ requestId }`.
 *   - leg 2, R-1 `POST {baseUrl}/association-attestations/digest` `{ answer, requesterKey }`
 *     → `{ digest, requestId, nonce }` (`requestId`/`nonce` ECHO `answer.requestId`/`answer.nonce`).
 *   - leg 2, R-2 `POST {baseUrl}/association-attestations`
 *     `{ answer, requesterKey, signature }` → `{}`.
 *   - `GET {baseUrl}/association-decisions?since={cursor}` (param omitted
 *     entirely when there is no cursor) → `{ notices }`.
 */

/** Local restatement of the seam's signature union (not exported by
 * `association-request-transport.ts`, so this module redeclares it rather
 * than importing a private type — matching the registration sibling's own
 * local alias, the established convention for these transport files). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * Structural alias for the global `fetch` signature. Ambient `fetch`,
 * `Response`, and `AbortSignal.timeout` typings are supplied by
 * `@types/node`'s own web-globals declarations (NOT `lib.dom`), so this
 * package's existing `"lib": ["ES2022"], "types": ["node", "mocha"]`
 * configuration already type-checks this file with no `tsconfig` edit, no
 * `"dom"` lib addition, and no new dependency.
 */
type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 15_000

/* WR-10: the closed status union and its guard live on the seam
 * (`association-request-transport.ts`: `KNOWN_ASSOCIATION_STATUS_CODES` /
 * `assertKnownAssociationStatus`) so every binding applies the SAME rule
 * from the SAME definition. Do not re-declare either here. */

interface DigestHandshakeResponseBody {
  digest?: unknown
  submittedAt?: unknown
}

interface AttestationDigestHandshakeResponseBody {
  digest?: unknown
  requestId?: unknown
  nonce?: unknown
}

interface SubmitResponseBody {
  requestId?: unknown
}

interface PollResponseBody {
  notices?: unknown
}

export interface RestAssociationTransportOptions {
  /** The endpoint's origin, e.g. `https://association.example.org`. An
   * `https://` origin is expected in any real deployment; `http://` is
   * acceptable only for a loopback test server. A trailing slash is
   * normalized once here so path joining elsewhere is unambiguous. */
  baseUrl: string
  /** Static headers merged into every request (e.g. an operator-supplied
   * bearer token). This is a transport-level convenience for reaching an
   * endpoint that requires one — it is explicitly NOT the authorization
   * gate. The request row's own signature is what the schema authorizes on
   * (D-02); a bogus or absent header can at worst waste the poller's time. */
  headers?: Record<string, string>
  /** Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Defaults to 15 000. */
  timeoutMs?: number
  /** Overrides the `fetch` implementation used. Exists ONLY so a host
   * lacking a global `fetch` can supply one — it is NOT a mocking seam. */
  fetchImpl?: FetchLike
}

/**
 * `RestAssociationTransport` — the D-08 pull-based REST binding. See the
 * module header above for the pull-only design, the zero-dependency
 * constraint, the TLS/signature trust split, the per-leg digest-handshake
 * discipline, and the D-17 hardware-ceremony carrier property this class is
 * built around.
 */
export class RestAssociationTransport implements IAssociationRequestTransport {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor (options: RestAssociationTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const impl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch
    if (impl === undefined) {
      throw new Error('RestAssociationTransport: no fetchImpl was supplied and globalThis.fetch is unavailable on this host')
    }
    this.fetchImpl = impl
  }

  /**
   * CR-03: refuse to sign 32 bytes the endpoint chose.
   *
   * `expected` is recomputed locally from values the client already holds; `received` is what
   * the digest handshake returned. They are compared as BYTES, not as strings, because the wire
   * form is not pinned to one encoding — `digestToBytes` accepts both the 43-char base64url the
   * SQL `Digest()` emits and a 64-char hex rendering of the same 32 bytes, and a string compare
   * would reject an honest endpoint that used the other one.
   *
   * A malformed `received` throws out of `digestToBytes` with its own loud message; that is the
   * correct outcome here too, so it is deliberately not caught.
   *
   * Neither the digest bytes nor any signature is ever put in the message (module rule).
   */
  private assertDigestMatchesLocalRecomputation (received: string, expected: string, site: string): void {
    const receivedBytes = digestToBytes(received)
    const expectedBytes = digestToBytes(expected)
    let diff = receivedBytes.length ^ expectedBytes.length
    for (let i = 0; i < Math.min(receivedBytes.length, expectedBytes.length); i++) {
      diff |= receivedBytes[i]! ^ expectedBytes[i]!
    }
    if (diff !== 0) {
      throw new Error(
        `RestAssociationTransport.${site}: the digest handshake returned a digest that does not match the tuple this client computed locally — refusing to sign endpoint-chosen bytes with the device key`
      )
    }
  }

  /**
   * Submits an association request (leg 1). Resolves the digest via an
   * engine-authoritative handshake (R-1) rather than reimplementing
   * `Digest()` client-side (it is the schema's function, and a TypeScript
   * reimplementation would fork it), signs the bytes the endpoint hands
   * back, and posts the signed document (R-2).
   */
  async submitRequest (
    init: AssociationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    // Pre-flight, BEFORE any network call: the engine binds `DeviceKey = requesterKey`, and so
    // does the leg-1 digest tuple this binding recomputes below. Mirroring
    // `AssociationEngine.submitAssociationRequest`'s own guard means a caller who bound the two
    // independently gets an attributable error instead of an opaque digest mismatch — and the
    // hostile-endpoint round trip never happens at all.
    if (init.deviceKey !== requesterKey) {
      throw new Error(
        `RestAssociationTransport.submitRequest: init.deviceKey (${init.deviceKey}) does not match requesterKey (${requesterKey}) — the digest tuple binds requesterKey into the DeviceKey position, so the two must agree`
      )
    }

    // --- R-1: digest handshake -------------------------------------------
    const handshake = await this.requestJson<DigestHandshakeResponseBody>('/association-requests/digest', {
      method: 'POST',
      body: { init, requesterKey }
    })
    if (typeof handshake.digest !== 'string' || handshake.digest.length === 0) {
      throw new Error('RestAssociationTransport.submitRequest: digest handshake returned an empty or missing digest')
    }
    if (typeof handshake.submittedAt !== 'string' || handshake.submittedAt.length === 0) {
      throw new Error('RestAssociationTransport.submitRequest: digest handshake returned an empty or missing submittedAt echo')
    }
    if (!handshake.submittedAt.endsWith('Z')) {
      // The schema's canonical-datetime CHECK requires the Z suffix; catching
      // a non-Z echo here surfaces the defect at the handshake instead of a
      // CHECK failure several layers away.
      throw new Error('RestAssociationTransport.submitRequest: digest handshake echoed a submittedAt without the required Z suffix')
    }
    // R-1's submittedAt is an ECHO of what the endpoint fed into the digest,
    // not a value this binding may adopt — deliberately a raw string `!==`
    // comparison, never a Date-parsed one: two strings that parse to the
    // same instant are still different digest inputs. If it diverges from
    // init.submittedAt, the endpoint digested a tuple the requester did not
    // sign, and the signature this binding is about to produce would fail
    // SignatureValid at write time — a layer away from the cause. Never
    // re-derive submittedAt from a clock; never assign it from this
    // response.
    if (handshake.submittedAt !== init.submittedAt) {
      throw new Error(
        "RestAssociationTransport.submitRequest: the digest handshake's submittedAt echo diverges from init.submittedAt — the endpoint digested a tuple the requester did not sign"
      )
    }

    // --- CR-03: the digest must be one this client can derive itself ------
    // The submittedAt echo above is a diagnostic, NOT a control (see header 8b): the endpoint
    // could satisfy it by handing back the value it was just given. This is the check that
    // actually pins the bytes.
    this.assertDigestMatchesLocalRecomputation(
      handshake.digest,
      computeAssociationRequestDigest(init, requesterKey),
      'submitRequest'
    )

    // --- Resolve the signature ---------------------------------------------
    const digestBytes = digestToBytes(handshake.digest)
    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      signature = await signatureOrCallback(digestBytes)
    } else {
      signature = signatureOrCallback
    }
    // A raw private key never enters this module and never crosses the
    // network. Never log, stringify, or embed the digest bytes or the
    // resolved signature in an error message.

    // --- R-2: submit ---------------------------------------------------------
    // The top-level submittedAt is bound FROM init — never from the R-1
    // response, never from a fresh clock reading. init is forwarded
    // verbatim.
    const submitResponse = await this.requestJson<SubmitResponseBody>('/association-requests', {
      method: 'POST',
      body: { init, requesterKey, submittedAt: init.submittedAt, signature }
    })
    if (typeof submitResponse.requestId !== 'string' || submitResponse.requestId !== init.id) {
      // An endpoint that renames the request is repointing the row the
      // requester signed; the mismatch must be loud, not absorbed.
      throw new Error('RestAssociationTransport.submitRequest: endpoint returned a requestId that does not match the id that was signed')
    }
    return init.id
  }

  /**
   * Submits an attestation answer (leg 2, D-18). NOT a widened
   * `submitRequest` — a distinct message over its OWN pair of endpoints
   * (`/association-attestations/digest` then `/association-attestations`),
   * never overloading the leg-1 endpoints. Mirrors leg 1's digest-handshake
   * shape exactly, except the handshake echo checked before signing is
   * `requestId` and `nonce`, not `submittedAt`.
   */
  async submitAttestation (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    // --- R-1: digest handshake -------------------------------------------
    const handshake = await this.requestJson<AttestationDigestHandshakeResponseBody>('/association-attestations/digest', {
      method: 'POST',
      body: { answer, requesterKey }
    })
    if (typeof handshake.digest !== 'string' || handshake.digest.length === 0) {
      throw new Error('RestAssociationTransport.submitAttestation: digest handshake returned an empty or missing digest')
    }
    if (typeof handshake.requestId !== 'string' || handshake.requestId.length === 0) {
      throw new Error('RestAssociationTransport.submitAttestation: digest handshake returned an empty or missing requestId echo')
    }
    if (typeof handshake.nonce !== 'string' || handshake.nonce.length === 0) {
      throw new Error('RestAssociationTransport.submitAttestation: digest handshake returned an empty or missing nonce echo')
    }
    // Both echoes are checked against the LOCALLY-HELD values before
    // anything is signed. Without this a hostile endpoint chooses what the
    // device signs — exactly the hazard leg 1's submittedAt check closes.
    if (handshake.requestId !== answer.requestId) {
      throw new Error(
        "RestAssociationTransport.submitAttestation: the digest handshake's requestId echo diverges from answer.requestId — the endpoint digested a tuple the requester did not sign"
      )
    }
    if (handshake.nonce !== answer.nonce) {
      throw new Error(
        "RestAssociationTransport.submitAttestation: the digest handshake's nonce echo diverges from answer.nonce — the endpoint digested a tuple the requester did not sign"
      )
    }

    // --- CR-03: the digest must be one this client can derive itself ------
    // Same reasoning as leg 1 (header 8b): the requestId/nonce echoes above are diagnostics,
    // and this is the check that stops the endpoint choosing what the hardware key signs.
    this.assertDigestMatchesLocalRecomputation(
      handshake.digest,
      computeAssociationAttestationDigest(answer),
      'submitAttestation'
    )

    // --- Resolve the signature ---------------------------------------------
    const digestBytes = digestToBytes(handshake.digest)
    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      signature = await signatureOrCallback(digestBytes)
    } else {
      signature = signatureOrCallback
    }
    // A raw private key never enters this module and never crosses the
    // network on this leg either.

    // --- R-2: submit ---------------------------------------------------------
    await this.requestJson<Record<string, unknown>>('/association-attestations', {
      method: 'POST',
      body: { answer, requesterKey, signature }
    })
  }

  /**
   * Pull model — the authority calls out and polls; it hosts no inbound
   * listener. Stateless with respect to the cursor: the caller supplies it,
   * this binding forwards it, and the binding holds none of its own between
   * calls. `since` is omitted entirely when `sinceCursor` is `undefined` —
   * never sent as the literal string `undefined`.
   */
  async pollDecisions (sinceCursor?: string): Promise<AssociationDecisionNotice[]> {
    const path = sinceCursor !== undefined && sinceCursor.length > 0
      ? `/association-decisions?since=${encodeURIComponent(sinceCursor)}`
      : '/association-decisions'
    const response = await this.requestJson<PollResponseBody>(path, { method: 'GET' })
    if (!Array.isArray(response.notices)) {
      throw new Error('RestAssociationTransport.pollDecisions: endpoint response is missing a notices array')
    }
    // Validate every notice and throw on the first malformed one — do not
    // filter, do not skip. Re-delivery is permitted, loss is not: a
    // silently dropped decision is a request that never gets acted on, with
    // no signal anywhere.
    const notices: AssociationDecisionNotice[] = []
    for (const raw of response.notices) {
      notices.push(this.parseNotice(raw))
    }
    return notices
  }

  private parseNotice (raw: unknown): AssociationDecisionNotice {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('RestAssociationTransport.pollDecisions: malformed decision notice (not an object)')
    }
    const candidate = raw as Record<string, unknown>
    const requestId = candidate.requestId
    const status = candidate.status
    const cursor = candidate.cursor
    const reason = candidate.reason
    const challengeNonce = candidate.challengeNonce
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('RestAssociationTransport.pollDecisions: decision notice is missing requestId')
    }
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new Error('RestAssociationTransport.pollDecisions: decision notice is missing cursor')
    }
    // WR-10: the shared seam guard — same rule, same message, one definition across the bindings.
    const knownStatus = assertKnownAssociationStatus(status, 'RestAssociationTransport.pollDecisions')
    if (reason !== undefined && typeof reason !== 'string') {
      throw new Error('RestAssociationTransport.pollDecisions: decision notice reason must be a string when present')
    }
    if (challengeNonce !== undefined && typeof challengeNonce !== 'string') {
      throw new Error('RestAssociationTransport.pollDecisions: decision notice challengeNonce must be a string when present')
    }
    return { requestId, status: knownStatus, challengeNonce, reason, cursor }
  }

  /**
   * Builds the URL from the normalized `baseUrl` + `path`, merges headers,
   * serializes `body` on a POST, and applies the per-request timeout. On a
   * non-2xx response the thrown error carries ONLY the status code and the
   * request path — never the response body, response headers, or request
   * body. A misconfigured or adversarial endpoint can echo submitted PII
   * back in an error body, and this repo's crash-payload discipline keeps
   * PII out of anything loggable. This omission is deliberate and must NOT
   * be "improved" later by appending `await response.text()`. A JSON parse
   * failure follows the same rule. A `fetch` rejection (network error /
   * timeout abort) is rethrown with the path appended and no other detail.
   */
  private async requestJson<T> (path: string, requestInit: { method: 'GET' | 'POST', body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = { ...this.headers, accept: 'application/json' }
    let body: string | undefined
    if (requestInit.method === 'POST') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(requestInit.body)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: requestInit.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new Error(`RestAssociationTransport: request to ${path} failed`)
    }

    if (!response.ok) {
      throw new Error(`RestAssociationTransport: request to ${path} failed with status ${response.status}`)
    }

    try {
      return await response.json() as T
    } catch {
      throw new Error(`RestAssociationTransport: request to ${path} returned status ${response.status} but the response body could not be parsed as JSON`)
    }
  }
}
