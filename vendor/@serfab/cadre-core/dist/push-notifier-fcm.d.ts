/**
 * push-notifier-fcm.ts — FCM HTTP v1 strand-wake delivery.
 *
 * Server-only: mints a Google OAuth2 access token (RS256 JWT bearer grant signed
 * with `node:crypto`) and POSTs a data message to the FCM v1 endpoint. The legacy
 * server-key `fcm.googleapis.com/fcm/send` API is deprecated, so we use HTTP v1.
 *
 * The network call is behind an injected `fetch`-like seam so unit tests assert
 * the request shape and map every documented response code with no real network
 * and no credentials. Failures are returned as {@link PushSendResult} values.
 *
 * Secret hygiene: the service-account `privateKey`, the minted JWT, and full
 * device tokens are never logged — failure log lines carry only a status/error
 * code and a redacted token prefix.
 */
import type { FcmCredentials } from './types.js';
import type { PushNotifier } from './push-notifier.js';
/** Minimal `fetch` Response shape the FCM sender consumes. */
export interface FcmResponseLike {
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
/** Injected `fetch`-like transport (default: global `fetch`). */
export type FcmFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<FcmResponseLike>;
export interface FcmPushDeps {
    /** Network transport. Defaults to global `fetch`. */
    fetch?: FcmFetch;
    /** Monotonic clock (ms). Defaults to `Date.now`. Injected for cache tests. */
    now?: () => number;
    /** Failure log seam (default: `debug('sereus:cadre:push:fcm')`). */
    log?: (line: string) => void;
}
export declare function createFcmPushNotifier(creds: FcmCredentials, deps?: FcmPushDeps): PushNotifier;
