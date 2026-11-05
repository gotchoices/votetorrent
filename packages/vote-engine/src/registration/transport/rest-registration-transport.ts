import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IRegistrationRequestTransport, RegistrationDecisionNotice } from './registration-request-transport.js'
import { assertKnownRegistrationStatus } from './registration-request-transport.js'
import { digestToBytes } from '../../utils.js'

/**
 * rest-registration-transport.ts — the D-01 pull-based REST binding,
 * `IRegistrationRequestTransport`'s SECOND real binding (the first is the
 * filesystem drop-file courier, `filesystem-registration-transport.ts`,
 * 48-09).
 *
 * **1. PULL BY DESIGN.** This binding only ever calls OUT. The authority
 * polls; it does not host an inbound webhook receiver, and it never binds a
 * port. `doc/registration.md:12`'s phrase "webhook/REST bridge" reads
 * naturally as "the authority receives inbound webhook POSTs" — that reading
 * is wrong here, and this comment states the correction explicitly so an
 * executor cannot arrive at the wrong reading by default: the phrase names a
 * *channel* (REST), not a *direction* (inbound). React Native cannot
 * reliably run a persistent background HTTP listener — there is no
 * long-running server process, the OS drives backgrounding and process-kill
 * semantics on its own schedule, and a NAT'd mobile device has no open
 * inbound port to defend in the first place. An inbound port on such a
 * device is additionally an attack surface with no way to close it.
 *
 * **2. Where a real push receiver would belong, if one is ever wanted:** a
 * small standalone Node service — this repo already has the precedent for
 * shipping infra tooling as its own package (`packages/p2p-probe-host`) —
 * never inside the app bundle. None is added in this phase.
 *
 * **3. Zero new dependencies.** This file uses only the Node/RN built-in
 * `fetch` and `AbortSignal.timeout`. Four HTTP-client packages are
 * deliberately absent and must stay absent: `axios`, `node-fetch`,
 * `express`, `fastify`. None of the four exists anywhere in this monorepo
 * today, and adding one for a single JSON round-trip is unwarranted — this
 * codebase has a documented aversion to new React Native bundling risk
 * (Phase 44's `@peculiar` device-boot wall cost two plans to unstick).
 *
 * **4. What makes a fetched document trustworthy here.** An `https://`
 * `baseUrl` is the expectation for any real deployment (`http://` is
 * acceptable only for a loopback test server); TLS protects confidentiality
 * and integrity **in transit** and authorizes NOTHING. The only thing that
 * makes a fetched request document trustworthy is the **requester's own
 * signature over the authority-issued digest**, which the schema's
 * `SignatureValid` CHECK verifies at INSERT (D-02). A binding that trusted
 * the endpoint instead of the signature would be trusting the network.
 * Certificate validation is the platform `fetch`'s; this file neither
 * disables nor overrides it.
 *
 * **5. The courier rule for `init.submittedAt`.** It is the submitter's own
 * signing-time timestamp and DG-1's seventh argument (48-02 L-3). This
 * binding forwards it **verbatim**: it never generates, defaults,
 * normalises, re-formats, or adopts a server-supplied replacement for it,
 * and it treats the digest handshake's echoed `submittedAt` as a value to
 * *verify*, never a value to *use*. A courier that rewrote it would
 * invalidate a signature it never touched, and the failure would surface at
 * the authority's INSERT — a layer away from its cause. The authority's own
 * intake observation is the separate `ReceivedAt` column, which is inside no
 * digest and never crosses this wire in either direction.
 *
 * **6. The `SignatureOrCallback` property.** This binding receives a
 * completed `Signature` or a digest→`Signature` callback and NEVER a raw
 * private key, so a channel that crosses a network holds no key material
 * (D-01/D-19).
 *
 * **7.** This file touches no ceremony. No sentence here claims the `'vrg'`
 * scope is enforced anywhere.
 *
 * **The wire protocol (locked, mirrored by the test-only server in this
 * package's spec file):**
 *   - R-1 `POST {baseUrl}/registration-requests/digest` `{ init, requesterKey }`
 *     → `{ digest, submittedAt }` (`submittedAt` is an ECHO of `init.submittedAt`).
 *   - R-2 `POST {baseUrl}/registration-requests`
 *     `{ init, requesterKey, submittedAt: init.submittedAt, signature }` → `{ requestId }`.
 *   - R-3 `GET {baseUrl}/registration-decisions?since={cursor}` (param omitted
 *     entirely when there is no cursor) → `{ notices }`.
 */

/** Local restatement of the seam's signature union (not exported by
 * `registration-request-transport.ts`, so this module redeclares it rather
 * than importing a private type — matching `local-authority-transport.ts`'s
 * own local alias, the established convention for these transport files). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * Structural alias for the global `fetch` signature. Ambient `fetch`,
 * `Response`, and `AbortSignal.timeout` typings are supplied by
 * `@types/node`'s own web-globals declarations (NOT `lib.dom`), so this
 * package's existing `"lib": ["ES2022"], "types": ["node", "mocha"]`
 * configuration already type-checks this file with no `tsconfig` edit, no
 * `"dom"` lib addition, and no new dependency. `FetchLike` exists only to
 * name the `fetchImpl` option's type — the ambient-global branch of Task 1
 * §E was the one needed; the minimal structural fallback was not.
 */
type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 15_000

/* WR-10: the closed status union and its guard used to be declared HERE, in this one binding —
 * the reason the other two bindings shipped without the check. Both now live on the seam
 * (`registration-request-transport.ts`: `KNOWN_REGISTRATION_STATUS_CODES` /
 * `assertKnownRegistrationStatus`) so every binding applies the SAME rule from the SAME
 * definition. Do not re-declare either here. */

interface DigestHandshakeResponseBody {
  digest?: unknown
  submittedAt?: unknown
}

interface SubmitResponseBody {
  requestId?: unknown
}

interface PollResponseBody {
  notices?: unknown
}

export interface RestRegistrationTransportOptions {
  /** The endpoint's origin, e.g. `https://registration.example.org`. An
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
   * lacking a global `fetch` can supply one — it is NOT a mocking seam.
   * This binding's spec drives the real global `fetch` against a real
   * socket, because a mocked `fetch` would prove the binding calls a
   * function, not that it speaks HTTP. */
  fetchImpl?: FetchLike
}

/**
 * `RestRegistrationTransport` — the D-01 pull-based REST binding. See the
 * module header above for the pull-only design, the zero-dependency
 * constraint, the TLS/signature trust split, and the `submittedAt` courier
 * rule this class is built around.
 */
export class RestRegistrationTransport implements IRegistrationRequestTransport {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor (options: RestRegistrationTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const impl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch
    if (impl === undefined) {
      throw new Error('RestRegistrationTransport: no fetchImpl was supplied and globalThis.fetch is unavailable on this host')
    }
    this.fetchImpl = impl
  }

  /**
   * Submits a registration request. The bridge case is expressed entirely
   * through `init.issuerType` / `init.bridgeId`, which this binding forwards
   * verbatim and without interpretation — one submit path, one signature
   * discipline, regardless of issuer (D-03); a binding that dropped or
   * defaulted these markers would make a bridge assertion arrive looking
   * like a voter's own cryptographically attributed act.
   *
   * Resolves the DG-1 digest via an engine-authoritative handshake (R-1)
   * rather than reimplementing `Digest()` client-side (it is the schema's
   * function, and a TypeScript reimplementation would fork it), signs the
   * bytes the endpoint hands back, and posts the signed document (R-2).
   */
  async submitRequest (
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    // --- R-1: digest handshake -------------------------------------------
    const handshake = await this.requestJson<DigestHandshakeResponseBody>('/registration-requests/digest', {
      method: 'POST',
      body: { init, requesterKey }
    })
    if (typeof handshake.digest !== 'string' || handshake.digest.length === 0) {
      throw new Error('RestRegistrationTransport.submitRequest: digest handshake returned an empty or missing digest')
    }
    if (typeof handshake.submittedAt !== 'string' || handshake.submittedAt.length === 0) {
      throw new Error('RestRegistrationTransport.submitRequest: digest handshake returned an empty or missing submittedAt echo')
    }
    if (!handshake.submittedAt.endsWith('Z')) {
      // The schema's SubmittedAtValid CHECK requires the Z suffix; catching
      // a non-Z echo here surfaces the defect at the handshake instead of a
      // CHECK failure several layers away.
      throw new Error('RestRegistrationTransport.submitRequest: digest handshake echoed a submittedAt without the required Z suffix')
    }
    // R-1's submittedAt is an ECHO of what the endpoint fed into the digest,
    // not a value this binding may adopt — deliberately a raw string `!==`
    // comparison, never a Date-parsed one: two strings that parse to the
    // same instant are still different digest inputs. If it differs from
    // init.submittedAt, the endpoint digested a tuple the requester did not
    // sign, and the signature this binding is about to produce would fail
    // SignatureValid inside the authority's INSERT — a plan away from the
    // cause. Never re-derive submittedAt from a clock; never assign it from
    // this response.
    if (handshake.submittedAt !== init.submittedAt) {
      throw new Error(
        "RestRegistrationTransport.submitRequest: the digest handshake's submittedAt echo diverges from init.submittedAt — the endpoint digested a tuple the requester did not sign"
      )
    }

    // --- Resolve the signature ---------------------------------------------
    const digestBytes = digestToBytes(handshake.digest)
    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      signature = await signatureOrCallback(digestBytes)
    } else {
      signature = signatureOrCallback
    }
    // Never read Signature.signerUserId here: a prospective registrant has
    // no User row, and touching that field is how a User dependency creeps
    // back into the submission path (D-02/D-04). Never log, stringify, or
    // embed the digest bytes or the resolved signature in an error message.

    // --- R-2: submit ---------------------------------------------------------
    // The top-level submittedAt is bound FROM init — never from the R-1
    // response, never from a fresh clock reading — so this binding keeps
    // exactly one source of truth for the value while the wire carries the
    // mirror a receiver cross-checks (48-13 asserts all three positions are
    // identical). init is forwarded verbatim; issuerType/bridgeId/
    // submittedAt are never defaulted, dropped, re-formatted, or normalized.
    const submitResponse = await this.requestJson<SubmitResponseBody>('/registration-requests', {
      method: 'POST',
      body: { init, requesterKey, submittedAt: init.submittedAt, signature }
    })
    if (typeof submitResponse.requestId !== 'string' || submitResponse.requestId !== init.id) {
      // An endpoint that renames the request is repointing the row the
      // requester signed; the mismatch must be loud, not absorbed.
      throw new Error('RestRegistrationTransport.submitRequest: endpoint returned a requestId that does not match the id that was signed')
    }
    return init.id
  }

  /**
   * Pull model — the authority calls out and polls; it hosts no inbound
   * listener. Stateless with respect to the cursor: the caller supplies it,
   * this binding forwards it, and the binding holds none of its own between
   * calls. `since` is omitted entirely when `sinceCursor` is `undefined` —
   * never sent as the literal string `undefined`.
   */
  async pollDecisions (sinceCursor?: string): Promise<RegistrationDecisionNotice[]> {
    const path = sinceCursor !== undefined && sinceCursor.length > 0
      ? `/registration-decisions?since=${encodeURIComponent(sinceCursor)}`
      : '/registration-decisions'
    const response = await this.requestJson<PollResponseBody>(path, { method: 'GET' })
    if (!Array.isArray(response.notices)) {
      throw new Error('RestRegistrationTransport.pollDecisions: endpoint response is missing a notices array')
    }
    // Validate every notice and throw on the first malformed one — do not
    // filter, do not skip. Re-delivery is permitted, loss is not: a
    // silently dropped decision is a request that never gets acted on, with
    // no signal anywhere.
    const notices: RegistrationDecisionNotice[] = []
    for (const raw of response.notices) {
      notices.push(this.parseNotice(raw))
    }
    return notices
  }

  private parseNotice (raw: unknown): RegistrationDecisionNotice {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('RestRegistrationTransport.pollDecisions: malformed decision notice (not an object)')
    }
    const candidate = raw as Record<string, unknown>
    const requestId = candidate.requestId
    const status = candidate.status
    const cursor = candidate.cursor
    const reason = candidate.reason
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('RestRegistrationTransport.pollDecisions: decision notice is missing requestId')
    }
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new Error('RestRegistrationTransport.pollDecisions: decision notice is missing cursor')
    }
    // WR-10: the shared seam guard — same rule, same message, one definition across the bindings.
    const knownStatus = assertKnownRegistrationStatus(status, 'RestRegistrationTransport.pollDecisions')
    if (reason !== undefined && typeof reason !== 'string') {
      throw new Error('RestRegistrationTransport.pollDecisions: decision notice reason must be a string when present')
    }
    return { requestId, status: knownStatus, reason, cursor }
  }

  /**
   * Builds the URL from the normalized `baseUrl` + `path`, merges headers,
   * serializes `body` on a POST, and applies the per-request timeout. On a
   * non-2xx response the thrown error carries ONLY the status code and the
   * request path — never the response body, response headers, or request
   * body. A misconfigured or adversarial endpoint can echo submitted PII
   * back in an error body, and this repo's crash-payload discipline (Phase
   * 47's param-hygiene gate) keeps PII out of anything loggable. This
   * omission is deliberate and must NOT be "improved" later by appending
   * `await response.text()`. A JSON parse failure follows the same rule. A
   * `fetch` rejection (network error / timeout abort) is rethrown with the
   * path appended and no other detail.
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
      throw new Error(`RestRegistrationTransport: request to ${path} failed`)
    }

    if (!response.ok) {
      throw new Error(`RestRegistrationTransport: request to ${path} failed with status ${response.status}`)
    }

    try {
      return await response.json() as T
    } catch {
      throw new Error(`RestRegistrationTransport: request to ${path} returned status ${response.status} but the response body could not be parsed as JSON`)
    }
  }
}
