import type {
	IRegistrationEngine,
	ReassociationReview,
	RegistrationContentAccess,
	RegistrationDecisionPublication,
	RegistrationDecisionPublishPort,
	RegistrationDecisionPublishResult,
	Signature,
} from '@votetorrent/vote-core';
import type {
	IKeyVault,
	IntakeEngine,
	IntakeOpener,
	P2pAssociationTransport,
	P2pRegistrationTransport,
	StagingDecisionSigner,
	StagingOpener,
} from '@votetorrent/vote-engine/rn';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';
import type { PeerStagingTransports } from '../../engines/engine-factory';

/**
 * continuity-review.ts — Phase 62 Plan 27 (D-41/D-44/D-45/D-49).
 *
 * The app-side seam the continuity screens share: a peer review session (opener plus both staging
 * transports plus a decide-time registration publisher), the never-throwing publish-after-decide
 * step, structural error classifiers, re-association display helpers and the D-49 unreadable-content
 * key mapping.
 *
 * This module never calls `createDeviceSigner`: the caller injects `sign`, which keeps it outside
 * the device-signing rollout inventory. It never logs, and no error message is built from row
 * values (names, identity fields, payload text are untrusted display data under the never-log rule).
 */

/**
 * The truncated device-key form every device surface renders. Kept as a local pure copy of
 * `AssociationsSection.truncateDeviceKey` (a parity test pins the two together): importing that
 * component module would drag the device signer and the i18n bootstrap into the registration
 * inbox's import graph, whose existing suite mocks `react-i18next` without `initReactI18next`.
 */
export function truncateDeviceKeyLabel(deviceKey: string): string {
	return deviceKey.slice(0, 5) + '...';
}

/** A device-key signer, as every ceremony in this app consumes it. */
export type DeviceSign = (digest: Uint8Array) => Promise<Signature>;

/**
 * Memoises `create()` on the first sign: constructing the session never prompts, and a ceremony
 * that signs twice (decide, then publish) resolves the signer once.
 */
export function createLazyDeviceSign(create: () => Promise<DeviceSign>): DeviceSign {
	let pending: Promise<DeviceSign> | undefined;
	return async (digest) => {
		pending ??= create();
		const sign = await pending;
		return sign(digest);
	};
}

/** Read-only review sessions never sign. */
export const readOnlyReviewSign: DeviceSign = () => Promise.reject(new Error('read-only review session'));

/**
 * Same shape as 62-25's `createRegistrationDecisionPublisher` (kept separate because it was a
 * same-wave sibling at plan time). It is the only shape in which a decide-time registration
 * decision reaches the strand (62-19 coordination): `RegistrationEngine.publishRegistrationDecision`
 * takes this port, never the transport directly.
 */
export function createDecideTimeRegistrationPublisher(
	transport: { publishDecision(d: RegistrationDecisionPublication): Promise<string> },
	authorityId: string,
): RegistrationDecisionPublishPort {
	return {
		authorityId,
		publishDecision: (d) => transport.publishDecision(d),
	};
}

export type PeerReviewUnavailableReason = 'no-transport-factory' | 'peer-strand-unavailable';

export class PeerReviewUnavailableError extends Error {
	readonly peerReviewUnavailable = true as const;
	readonly reason: PeerReviewUnavailableReason;

	constructor(reason: PeerReviewUnavailableReason) {
		super(`peer review unavailable: ${reason}`);
		this.name = 'PeerReviewUnavailableError';
		this.reason = reason;
	}
}

export function isPeerReviewUnavailable(e: unknown): boolean {
	return typeof e === 'object' && e !== null && (e as { peerReviewUnavailable?: unknown }).peerReviewUnavailable === true;
}

export interface PeerReviewDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	createPeerStagingTransports?: (deps: {
		opener: StagingOpener;
		decisionSigner: StagingDecisionSigner;
	}) => PeerStagingTransports;
	authorityId: string;
	/** Required. Screens pass `createLazyDeviceSign(() => createDeviceSigner("Device User"))`; read-only callers pass `readOnlyReviewSign`. */
	sign: DeviceSign;
	resolveVault?: () => IKeyVault;
}

export interface PeerReviewSession {
	readonly opener: IntakeOpener;
	readonly registration: P2pRegistrationTransport;
	readonly association: P2pAssociationTransport;
	readonly registrationPublisher: RegistrationDecisionPublishPort;
	/** Closes both transports once; never throws. */
	close(): Promise<void>;
}

/** Structural: a factory refusal carries `peerStrandUnavailable === true` (62-21). */
function isPeerStrandUnavailable(e: unknown): boolean {
	return typeof e === 'object' && e !== null && (e as { peerStrandUnavailable?: unknown }).peerStrandUnavailable === true;
}

export async function openPeerReviewSession(deps: PeerReviewDeps): Promise<PeerReviewSession> {
	if (deps.createPeerStagingTransports === undefined) {
		throw new PeerReviewUnavailableError('no-transport-factory');
	}
	const intake = await deps.getEngine<IntakeEngine>('intake');
	const opener = intake.createOpener((deps.resolveVault ?? resolveAuthorityKeyVault)());
	let transports: PeerStagingTransports;
	try {
		transports = deps.createPeerStagingTransports({
			opener,
			decisionSigner: { authorityId: deps.authorityId, sign: deps.sign },
		});
	} catch (e) {
		if (isPeerStrandUnavailable(e)) throw new PeerReviewUnavailableError('peer-strand-unavailable');
		throw e;
	}
	const { registration, association } = transports;
	const registrationPublisher = createDecideTimeRegistrationPublisher(registration, deps.authorityId);
	let closed = false;
	return {
		opener,
		registration,
		association,
		registrationPublisher,
		async close() {
			if (closed) return;
			closed = true;
			for (const transport of [registration, association] as Array<{ close?: () => unknown }>) {
				try {
					await transport.close?.();
				} catch {
					/* closing never throws into a screen */
				}
			}
		},
	};
}

export type PublishAfterDecideOutcome =
	| { kind: 'published'; result: RegistrationDecisionPublishResult }
	| { kind: 'still-pending' }
	| { kind: 'unavailable' }
	| { kind: 'failed'; code: string };

/**
 * Runs right after an officer's decision resolves (D-44). `closesRequestId` is the callout candidate
 * or null, never omitted: automatic closure would close a request the officer was never shown. A
 * failure leaves the decision for 62-25's `listUnpublishedRegistrationDecisions` drain. Publishing
 * signs, so it may prompt again. NEVER throws, and never copies an error message.
 */
export async function publishRegistrationDecisionAfterDecide(
	deps: PeerReviewDeps,
	requestId: string,
	closesRequestId: string | null,
): Promise<PublishAfterDecideOutcome> {
	if (deps.createPeerStagingTransports === undefined) return { kind: 'unavailable' };
	let session: PeerReviewSession | undefined;
	try {
		const reg = await deps.getEngine<IRegistrationEngine>('registration');
		const read = await reg.getRegistrationRequest(requestId);
		if (read?.status !== 'a' && read?.status !== 'r') return { kind: 'still-pending' };
		session = await openPeerReviewSession(deps);
		const result = await reg.publishRegistrationDecision(session.registrationPublisher, requestId, { closesRequestId });
		return { kind: 'published', result };
	} catch (e) {
		if (isPeerReviewUnavailable(e)) return { kind: 'unavailable' };
		const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
		return { kind: 'failed', code: typeof code === 'string' ? code : 'unknown' };
	} finally {
		if (session) await session.close();
	}
}

function hasNameAndCode(e: unknown): e is { name: unknown; code: unknown } {
	return typeof e === 'object' && e !== null;
}

/** Structural (name + code), never `instanceof` across the package boundary. */
export function isClosedAsDuplicateError(e: unknown): boolean {
	return hasNameAndCode(e) && e.name === 'RegistrationDuplicateError' && e.code === 'closed-as-duplicate';
}

/**
 * The engine refused to decide a request whose requester signature cannot be verified
 * (RequesterSignatureUnverifiableError, code 'requester-signature-unverifiable'). Fires before any
 * officer signature. Structural like its siblings, so a rethrown/cloned error still matches.
 */
export function isRequesterSignatureUnverifiableError(e: unknown): boolean {
	return hasNameAndCode(e) && e.name === 'RequesterSignatureUnverifiableError' && e.code === 'requester-signature-unverifiable';
}

export function isThresholdCoSignRefusal(e: unknown): boolean {
	return (
		hasNameAndCode(e) &&
		(e.name === 'ReassociationError' || e.name === 'IntakeError') &&
		e.code === 'threshold-requires-co-sign'
	);
}

export type ReassociationEvidenceView = 'code-matched' | 'identity' | 'code-unmatched' | 'code-unverifiable' | 'no-evidence';

export function classifyReassociationEvidence(review: ReassociationReview): ReassociationEvidenceView {
	const evidence = review.evidence;
	if (evidence.kind === 'identity') return 'identity';
	if (evidence.kind === 'none') return 'no-evidence';
	if (evidence.outcome === 'matched') return 'code-matched';
	if (evidence.outcome === 'unmatched') return 'code-unmatched';
	return 'code-unverifiable';
}

export function reassociationRegistrantLabel(review: ReassociationReview): string {
	return review.registrantName ?? truncateDeviceKeyLabel(review.newDeviceKey);
}

export type RegistrationContentUnreadKey =
	| 'registrationContentNotRecipient'
	| 'registrationContentNoKey'
	| 'registrationContentUnreadable'
	| 'registrationContentTampered';

/**
 * D-49: how this device read a sealed request, as a copy KEY name (the screens call `t()`).
 * Readable access (undefined, 'opened', 'unsealed') maps to undefined. 'unreadable' has its OWN
 * key: 62-31's 'unreadable' covers a malformed envelope, a failed authentication, a local vault
 * error and non-JSON plaintext, so the tampered copy would accuse the applicant of a mismatch that
 * a local vault error does not prove, and the no-key copy would send the officer to enable
 * encrypted intake when this device may already have it.
 */
export function registrationContentUnreadKey(
	access: RegistrationContentAccess | undefined,
): RegistrationContentUnreadKey | undefined {
	switch (access) {
		case 'not-a-recipient':
			return 'registrationContentNotRecipient';
		case 'no-opener':
			return 'registrationContentNoKey';
		case 'unreadable':
			return 'registrationContentUnreadable';
		case 'tampered':
			return 'registrationContentTampered';
		default:
			return undefined;
	}
}

/** Structural: name + code + a string `access`. Its `message` (request id, access code) is never rendered. */
export function isRegistrationContentAccessError(
	e: unknown,
): e is { name: 'RegistrationContentAccessError'; code: 'registration-content-unreadable'; access: RegistrationContentAccess } {
	if (typeof e !== 'object' || e === null) return false;
	const x = e as { name?: unknown; code?: unknown; access?: unknown };
	return x.name === 'RegistrationContentAccessError' && x.code === 'registration-content-unreadable' && typeof x.access === 'string';
}
