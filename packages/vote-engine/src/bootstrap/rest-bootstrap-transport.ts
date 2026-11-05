import type { IBootstrapTransport, BootstrapRedemptionResult } from './bootstrap-transport.js'
import { assertKnownBootstrapRedemptionStatus } from './bootstrap-transport.js'
import type { SealedPayload } from './sealed-payload.js'
import { deriveBootstrapKeys } from './sealed-payload.js'

/**
 * rest-bootstrap-transport.ts — the D-06 pull-only REST binding,
 * `IBootstrapTransport`'s SECOND real binding (the first is the filesystem
 * binding, `filesystem-bootstrap-transport.ts`).
 *
 * **1. THIS BINDING ONLY EVER CALLS OUT.** It does not host an inbound
 * webhook receiver and it never binds a port — neither the browser dashboard
 * nor the React Native authority app can listen, and that constraint is
 * unchanged. What HAS changed is the other end: the receiver this binding
 * calls is the standalone bootstrap rendezvous service built in this phase,
 * a small Node service outside every app bundle, exactly where such a
 * receiver belongs. A later reader must not restore the old sentence
 * claiming no such service exists.
 *
 * **2. Zero new dependencies.** Global `fetch` and `AbortSignal.timeout`
 * only. `axios`, `node-fetch`, `express` and `fastify` are deliberately
 * absent from this repo and must stay absent.
 *
 * **3. Browser- and Hermes-safe.** No `node:` specifier, no `Buffer`, no
 * `process`. This is the ONE binding that appears in the `./bootstrap`
 * barrel, so any such import breaks the Vite bundle AND the React Native
 * bundle at once.
 *
 * **4. What makes a fetched snapshot trustworthy.** An `https://` `baseUrl`
 * and a configured bearer header protect transit and authorize NOTHING.
 * The trust anchor is 50-02's manifest row-count + content digest + schema
 * hash, verified by the CONSUMER after this binding returns — against an
 * `expectedDigest` read off the officer's phone out of band, never against
 * anything this binding fetched. A binding that trusted the endpoint
 * instead of the content check would be trusting the network.
 *
 * Relatedly, and forced rather than preferred (D-04): this binding transmits
 * the DERIVED LOOKUP HALF of the code, never the raw secret. `redeem` is
 * handed the secret because the filesystem binding legitimately needs it as
 * a path segment, but the moment a network is involved, sending it would put
 * the private half's derivation input into the receiver's hands — it could
 * then derive the payload's decryption key from the very request that asks
 * for the payload, and the sealing would be theatre. See
 * `secretToLookupId` below, which returns the lookup half and discards the
 * private half in the same expression.
 *
 * **5. The locked wire protocol**, mirrored by the test-only receiver in
 * this package's conformance spec:
 *   - B-1 `POST {baseUrl}/bootstrap/redemptions` with body `{ lookupId }`
 *     -> `{ status, sealed? }`, where `sealed` is present if and only if
 *     `status === 'ok'` and is returned to the caller UNOPENED.
 *
 * There is exactly one route. A second, cursor-shaped `GET
 * {baseUrl}/bootstrap/snapshot` route (B-2) existed alongside it and was
 * REMOVED together with the seam's pull-style method under D-07; the
 * rendezvous service deliberately serves no such route. It must not be
 * restored here: a keyless pull has no out-of-band digest to verify against,
 * and a shared current document has no single key that opens it.
 *
 * No sentence in this file claims any scope is enforced here. This binding
 * never logs.
 */

/** Structural alias for the global `fetch` signature. Ambient `fetch`,
 * `Response`, and `AbortSignal.timeout` typings are supplied by
 * `@types/node`'s own web-globals declarations, so this file type-checks
 * with no `tsconfig` edit and no new dependency. */
type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 15_000

interface RedemptionResponseBody {
  status?: unknown
  sealed?: unknown
}

/** Anchored lowercase-hex, used to screen the bearer secret BEFORE it is
 * decoded. See `secretToLookupId` for why the screening has to come first. */
const HEX_SECRET_PATTERN = /^[0-9a-f]+$/

/**
 * Derive the D-04 lookup half of a bearer secret — the only half this
 * binding is allowed to transmit.
 *
 * The shape check runs BEFORE the decode, and the thrown message names the
 * OBSERVED LENGTH ONLY, never the value: the same discipline
 * `assertKnownBootstrapRedemptionStatus` follows, applied to a value that is
 * a bearer credential.
 *
 * The hex decode is a local loop rather than `@noble/hashes`'s `hexToBytes`
 * on purpose. That helper's `RangeError` embeds two characters of the
 * offending string in its message, and here the offending string IS the
 * bearer secret — a leak into any log or error surface that ever renders it.
 *
 * `deriveBootstrapKeys` returns both halves; this function reads the lookup
 * half straight off the returned object and lets the private half go out of
 * scope in the same expression. It is never bound to a variable, never
 * stored on the instance, and never logged.
 */
function secretToLookupId (code: string): string {
  if (typeof code !== 'string' || code.length === 0 || code.length % 2 !== 0 || !HEX_SECRET_PATTERN.test(code)) {
    const observed = typeof code === 'string' ? code.length : -1
    throw new Error(
      `RestBootstrapTransport.redeem: code must be an even-length lowercase-hex secret (observed length ${observed})`
    )
  }
  const bytes = new Uint8Array(code.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(code.slice(i * 2, i * 2 + 2), 16)
  }
  return deriveBootstrapKeys(bytes).lookupId
}

export interface RestBootstrapTransportOptions {
  /** The endpoint's origin, e.g. `https://bootstrap.example.org`. An
   * `https://` origin is expected in any real deployment; `http://` is
   * acceptable only for a loopback test server. A trailing slash is
   * normalized once here so path joining elsewhere is unambiguous. */
  baseUrl: string
  /** Static headers merged into every request (e.g. an operator-supplied
   * bearer token). This is a transport-level convenience for reaching an
   * endpoint that requires one — it is explicitly NOT the authorization
   * gate. The trust anchor is 50-02's manifest+digest+schema-hash check,
   * performed by the consumer (see header rule 4). */
  headers?: Record<string, string>
  /** Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Defaults to 15 000. */
  timeoutMs?: number
  /** Overrides the `fetch` implementation used. Exists ONLY so a host
   * lacking a global `fetch` can supply one — it is NOT a mocking seam.
   * This binding's conformance spec drives the real global `fetch` against
   * a real socket, because a mocked `fetch` would prove the binding calls
   * a function, not that it speaks HTTP. */
  fetchImpl?: FetchLike
}

/**
 * `RestBootstrapTransport` — the D-06 pull-only REST binding. See the
 * module header above for the pull-only design, the zero-dependency
 * constraint, and the TLS/digest trust split this class is built around.
 */
export class RestBootstrapTransport implements IBootstrapTransport {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor (options: RestBootstrapTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // The global `fetch` MUST be bound to `globalThis` at capture. Native
    // `fetch` is a Window/WorkerGlobalScope method with a Web IDL brand
    // check on its receiver, and it is stored here and later invoked as
    // `this.fetchImpl(...)` — a call whose receiver is the transport
    // instance, not the global. Unbound, every browser throws
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
    // before the request is ever sent, which `requestJson`'s catch then
    // reports as an unreachable endpoint. Node's `fetch` has no such brand
    // check, so the Node conformance spec cannot observe this — do not
    // remove the bind because the tests still pass without it.
    const impl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis)
    if (impl === undefined) {
      throw new Error('RestBootstrapTransport: no fetchImpl was supplied and globalThis.fetch is unavailable on this host')
    }
    this.fetchImpl = impl
  }

  /**
   * Redeem a bearer bootstrap code via B-1.
   *
   * The lookup half is derived FIRST, before any socket is touched, so a
   * malformed code is refused locally and never reaches the network — and so
   * the raw secret is never what this binding sends (D-04, header rule 4).
   *
   * The response's `status` is narrowed through the seam's shared guard —
   * never a local re-declared status set and never an
   * `as BootstrapRedemptionStatus` coercion. On `'ok'` the response's
   * `sealed` member is returned UNOPENED; on any refusal `sealed` is
   * omitted, and a refusal that still carries a sealed payload is thrown as
   * a source defect — it must surface here, not downstream.
   */
  async redeem (code: string): Promise<BootstrapRedemptionResult> {
    const lookupId = secretToLookupId(code)
    const body = await this.requestJson<RedemptionResponseBody>('/bootstrap/redemptions', {
      method: 'POST',
      body: { lookupId }
    })
    const status = assertKnownBootstrapRedemptionStatus(body.status, 'RestBootstrapTransport.redeem')

    if (status === 'ok') {
      if (body.sealed === undefined || body.sealed === null) {
        throw new Error("RestBootstrapTransport.redeem: response status was 'ok' but the response carried no sealed payload")
      }
      // A CAST, NOT A VALIDATION — and deliberately so (seam rule 5). This
      // binding is a courier: it deserialized its own transport encoding and
      // stops there. `unsealPayload`, above the seam, performs the
      // structural check and owns the `malformed-wrapper` refusal. A field
      // check added here would move that judgement into the courier.
      return { status: 'ok', sealed: body.sealed as SealedPayload }
    }

    if (body.sealed !== undefined && body.sealed !== null) {
      // A source that refuses and still ships data is a defect that must
      // surface here, not be silently forwarded downstream.
      throw new Error(`RestBootstrapTransport.redeem: response status was '${status}' but the response still carried a sealed payload`)
    }
    return { status }
  }

  /**
   * Builds the URL from the normalized `baseUrl` + `path`, merges headers,
   * serializes `body` on a POST, and applies the per-request timeout. On a
   * non-2xx response the thrown Error carries ONLY the status code and the
   * request path — never the response body, response headers, or request
   * body. A JSON parse failure follows the same rule. A `fetch` rejection
   * is rethrown with the path appended and no other detail.
   *
   * This omission is load-bearing, not stylistic: the request body carries
   * the BEARER CODE and the response body is a WHOLE-DATABASE snapshot
   * including registrant PII, so an `await response.text()` appended here
   * would be a direct PII and credential leak. This must NOT be "improved"
   * later.
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
      // Invoked through a local binding so the receiver is never `this` —
      // see the constructor's note on the Web IDL brand check.
      const fetchImpl = this.fetchImpl
      response = await fetchImpl(url, {
        method: requestInit.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new Error(`RestBootstrapTransport: request to ${path} failed`)
    }

    if (!response.ok) {
      throw new Error(`RestBootstrapTransport: request to ${path} failed with status ${response.status}`)
    }

    try {
      return await response.json() as T
    } catch {
      throw new Error(`RestBootstrapTransport: request to ${path} returned status ${response.status} but the response body could not be parsed as JSON`)
    }
  }
}
