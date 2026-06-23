/**
 * push-notifier-apns.ts — APNs HTTP/2 strand-wake delivery.
 *
 * Server-only: signs a provider JWT (ES256, JOSE raw r‖s via `node:crypto`) and
 * sends a background data push over an HTTP/2 session to Apple's gateway.
 *
 * The HTTP/2 call is behind an injected `Http2Requester` seam (bundled with a
 * `close` into an {@link ApnsTransport}) so unit tests assert the request shape
 * and map every documented response code with no real network and no credentials.
 * The default transport owns a single lazily-(re)established `node:http2` session.
 *
 * Two single-shot retries guard transient failure without a retry storm: a
 * thrown transport error (session death / GOAWAY mid-send) re-establishes the
 * session and retries the one request once; a 403 `ExpiredProviderToken`
 * re-mints the provider JWT and retries once. A second failure is returned as-is.
 *
 * Secret hygiene: the `.p8` `privateKey`, the minted JWT, and full device tokens
 * are never logged — failure log lines carry only a status/reason and a redacted
 * token prefix.
 */
import type { ApnsCredentials } from './types.js';
import type { PushNotifier } from './push-notifier.js';
/** Raw HTTP/2 response: APNs `:status` and the (possibly empty) JSON body. */
export interface ApnsResponse {
    status: number;
    body: string;
}
/** A single APNs HTTP/2 request — `:path`, headers, and the JSON body. */
export interface ApnsRequest {
    /** `:path`, e.g. `/3/device/{token}`. */
    path: string;
    headers: Record<string, string>;
    body: string;
}
/**
 * Low-level HTTP/2 request seam. Resolves with the `(status, body)` pair; rejects
 * (throws) on a session/transport failure so the caller can re-establish + retry.
 */
export type Http2Requester = (req: ApnsRequest) => Promise<ApnsResponse>;
/** The HTTP/2 request seam plus its session-teardown. */
export interface ApnsTransport {
    request: Http2Requester;
    close(): Promise<void>;
}
export interface ApnsPushDeps {
    /** HTTP/2 transport. Defaults to a real `node:http2` session manager. */
    transport?: ApnsTransport;
    /** Monotonic clock (ms). Defaults to `Date.now`. Injected for token-cache tests. */
    now?: () => number;
    /** Failure log seam (default: `debug('sereus:cadre:push:apns')`). */
    log?: (line: string) => void;
}
export declare function createApnsPushNotifier(creds: ApnsCredentials, deps?: ApnsPushDeps): PushNotifier;
