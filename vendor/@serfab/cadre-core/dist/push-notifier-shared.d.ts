/**
 * push-notifier-shared.ts — internal helpers shared by the FCM and APNs
 * push-notifier implementations. Server-only (used only by modules that already
 * reach for `node:crypto` / `node:http2`); never re-exported from the package
 * entry. Centralized so the secret-redaction and payload-bounding rules have a
 * single, hardenable source rather than drifting between the two transports.
 */
/** Defensive cap on the free-form `reason` carried in a strand-wake payload. */
export declare const MAX_REASON_LEN = 256;
/** Base64url-encode the JSON form of an object (JWT header/claims segments). */
export declare function b64urlJson(obj: unknown): string;
/** A short, secret-free string for an unknown thrown value. */
export declare function errText(err: unknown): string;
/**
 * Redact a device token to a short, non-reversible prefix for debug lines — the
 * full FCM/APNs token is a secret and must never reach a log.
 */
export declare function redact(token: string): string;
