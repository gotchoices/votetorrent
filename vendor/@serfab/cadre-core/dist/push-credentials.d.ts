/**
 * push-credentials.ts — pure validation + log-redaction for {@link PushCredentials}.
 *
 * The platform-push credentials a deployment provisions (`cadre-host` from its
 * secret store, `cadre-provider` from per-tenant config) are written into a
 * spawned node's config under `CadreNodeConfig.push`. This module is the
 * dependency-free seam those provisioners share to (a) reject a *partial* set
 * before it reaches a node — a present platform block must carry all its required
 * fields, or it fails fast at provisioning rather than at first push — and (b)
 * produce a log-safe view that never leaks a private key.
 *
 * It imports only the *types* (erased at emit), so it pulls no node:crypto /
 * node:http2 edge — a provisioner can import these functions without dragging in
 * the FCM/APNs senders.
 */
import type { PushCredentials } from './types.js';
/** Marker substituted for every secret field by {@link redactPushCredentials}. */
export declare const REDACTED = "[redacted]";
/**
 * Validate a resolved push-credential bundle, returning human-readable errors
 * (empty ⇒ valid). Each platform block is optional, but a *present* block must
 * carry every required field — a partial set (e.g. APNs `keyId` without
 * `privateKey`) is a misconfiguration that must surface at provisioning time, not
 * silently at the first wake. A bundle with neither platform is valid (push is
 * opt-in); callers that require at least one platform check that separately.
 */
export declare function validatePushCredentials(push: PushCredentials): string[];
/**
 * Return a log-safe shallow copy of a push bundle with every private key replaced
 * by {@link REDACTED}. Use this for ANY debug/log line that touches push config —
 * `privateKey` fields are secrets and must never reach a log sink (the same rule
 * the startup/seed tokens follow).
 */
export declare function redactPushCredentials(push: PushCredentials): Record<string, unknown>;
