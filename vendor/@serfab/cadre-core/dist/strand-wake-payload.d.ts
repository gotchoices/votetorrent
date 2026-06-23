/**
 * strand-wake-payload.ts — the canonical wire contract for a strand-wake data
 * message, shared by the server-side sender (`PushNotifier`, this package) and
 * the mobile receiver (`@serfab/reference-app-rn`'s `push-wake.ts`).
 *
 * A strand-wake is a data-only push delivered to an OS-suspended phone over its
 * platform channel (FCM/APNs) when a control-network dial cannot reach the
 * hibernating process. It names the strand that has pending activity so the phone
 * can run one `serviceWake` cycle and re-hibernate.
 *
 * This module is intentionally dependency-free (no node/RN/browser-specific
 * imports) so it sits cleanly on the cross-platform `cadre-core` entry and can be
 * re-exported by the RN receive module without dragging any platform code across
 * the send/receive boundary. The defensive `parseStrandWakePayload` parser stays
 * on the receive side (it guards untrusted wire input); the sender constructs
 * payloads from typed fields and never parses.
 */
/** Discriminator value carried by a strand-wake data message. */
export declare const STRAND_WAKE_TYPE = "strand-wake";
/**
 * A data-only push payload telling a suspended phone that `strandId` has pending
 * activity. Delivered addressed to the phone's resolved `DeviceToken`.
 */
export interface StrandWakePayload {
    type: typeof STRAND_WAKE_TYPE;
    /** The strand the wake is for. */
    strandId: string;
    /** Why the wake was sent (e.g. `'activity'`). Free-form, for diagnostics. */
    reason: string;
}
