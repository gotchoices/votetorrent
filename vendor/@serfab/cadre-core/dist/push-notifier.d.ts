/**
 * push-notifier.ts — the platform-push **delivery** seam for strand-wake.
 *
 * Given a resolved mobile peer token, send one `strand-wake` data message over
 * the right platform channel (FCM for Android, APNs for iOS). This module owns no
 * policy — *who* to wake and *when* is the fan-out (`push-fanout.ts`). It is the
 * reusable, credential-injected, transport-injected unit the fan-out constructs
 * inside a participating `CadreNode` when push credentials are configured.
 *
 * `createPushNotifier` returns a router that dispatches by `msg.platform` to an
 * `FcmPushNotifier` and/or `ApnsPushNotifier`, constructing only the
 * implementations whose credentials are present. Failures are values, never
 * thrown — mirroring `ServiceWakeResult` / `resolveDeviceToken`'s no-throw
 * conventions so a best-effort fan-out can branch on the outcome.
 *
 * Server-only by construction: the FCM/APNs implementations reach for
 * `node:crypto` / `node:http2`. They are never pulled into the RN/browser bundle
 * because the cross-platform `index.ts` re-exports only the *types* here (a
 * type-only re-export is erased at emit), and the only runtime constructor of a
 * notifier is the in-package fan-out that runs inside a Node `CadreNode`. A
 * cross-platform consumer imports the payload contract + types, never this value.
 */
import type { PushPlatform, PushCredentials } from './types.js';
import type { StrandWakePayload } from './strand-wake-payload.js';
import { type FcmPushDeps } from './push-notifier-fcm.js';
import { type ApnsPushDeps } from './push-notifier-apns.js';
/** One strand-wake data message addressed to one device. */
export interface PushMessage {
    /** The resolved `DeviceToken.token` for the target peer. */
    token: string;
    /** Which channel — selects FCM vs APNs. */
    platform: PushPlatform;
    /** The strand-wake payload `{ type:'strand-wake', strandId, reason }`. */
    payload: StrandWakePayload;
}
/**
 * Outcome of a single {@link PushNotifier.send}. A delivery failure is a value,
 * never a thrown error. `unregistered: true` means the platform reported the
 * token is permanently invalid (FCM 404 `UNREGISTERED` / 400 naming the token;
 * APNs 410 `Unregistered` / 400 `BadDeviceToken`) — the caller should expire the
 * stale `DeviceToken`. Any other failure is `unregistered: false` and is treated
 * as best-effort/transient (no retry storm).
 */
export type PushSendResult = {
    ok: true;
} | {
    ok: false;
    unregistered: boolean;
    error: string;
};
export interface PushNotifier {
    /** Send one strand-wake data message to one device. Never throws. */
    send(msg: PushMessage): Promise<PushSendResult>;
    /** Release transport resources (e.g. the APNs HTTP/2 session). */
    close(): Promise<void>;
}
/**
 * Per-platform transport/clock/log seams, injected by tests. Defaults are the
 * real implementations (global `fetch` for FCM, a `node:http2` session for APNs).
 */
export interface PushNotifierDeps {
    fcm?: FcmPushDeps;
    apns?: ApnsPushDeps;
}
/**
 * Build a {@link PushNotifier} router over the configured credentials. Only the
 * platforms whose credentials are present get a backing implementation; a `send`
 * for an unconfigured platform returns a best-effort `no <platform> credentials`
 * failure rather than throwing.
 */
export declare function createPushNotifier(creds: PushCredentials, deps?: PushNotifierDeps): PushNotifier;
