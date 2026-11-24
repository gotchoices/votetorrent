/**
 * continuity-review.ts — Authority binding (67-09). The review-session logic moved to
 * `packages/workflows/src/authority/continuity-review.ts`; this path stays so existing imports, `jest.mock`
 * paths and screens keep working, and supplies the app's native-wrapped vault (`resolveAuthorityKeyVault`)
 * by FUNCTION REFERENCE, so it is still resolved once per session. */
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	PeerReviewUnavailableError,
	classifyReassociationEvidence,
	createDecideTimeRegistrationPublisher,
	createLazyDeviceSign,
	isClosedAsDuplicateError,
	isPeerReviewUnavailable,
	isRegistrationContentAccessError,
	isRequesterSignatureUnverifiableError,
	isReviewPendingRefusal,
	isThresholdCoSignRefusal,
	openPeerReviewSession as openShared,
	publishRegistrationDecisionAfterDecide as publishShared,
	readOnlyReviewSign,
	reassociationRegistrantLabel,
	registrationContentUnreadKey,
	truncateDeviceKeyLabel,
	type DeviceSign,
	type PeerReviewDeps as SharedPeerReviewDeps,
	type PeerReviewSession,
	type PeerReviewUnavailableReason,
	type PublishAfterDecideOutcome,
	type ReassociationEvidenceView,
	type RegistrationContentUnreadKey,
} from '@votetorrent/workflows/authority';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';

export {
	PeerReviewUnavailableError,
	classifyReassociationEvidence,
	createDecideTimeRegistrationPublisher,
	createLazyDeviceSign,
	isClosedAsDuplicateError,
	isPeerReviewUnavailable,
	isRegistrationContentAccessError,
	isRequesterSignatureUnverifiableError,
	isReviewPendingRefusal,
	isThresholdCoSignRefusal,
	readOnlyReviewSign,
	reassociationRegistrantLabel,
	registrationContentUnreadKey,
	truncateDeviceKeyLabel,
};
export type { DeviceSign, PeerReviewSession, PeerReviewUnavailableReason, PublishAfterDecideOutcome, ReassociationEvidenceView, RegistrationContentUnreadKey };

export interface PeerReviewDeps extends Omit<SharedPeerReviewDeps, 'resolveVault'> {
	resolveVault?: () => IKeyVault;
}

function withAppVault(deps: PeerReviewDeps): SharedPeerReviewDeps {
	return { ...deps, resolveVault: deps.resolveVault ?? resolveAuthorityKeyVault };
}

export async function openPeerReviewSession(deps: PeerReviewDeps): Promise<PeerReviewSession> {
	return openShared(withAppVault(deps));
}

export async function publishRegistrationDecisionAfterDecide(
	deps: PeerReviewDeps,
	requestId: string,
	closesRequestId: string | null,
): Promise<PublishAfterDecideOutcome> {
	return publishShared(withAppVault(deps), requestId, closesRequestId);
}
