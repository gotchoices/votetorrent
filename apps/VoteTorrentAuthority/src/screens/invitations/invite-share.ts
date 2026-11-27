/**
 * invite-share.ts — thin binding. The invitation-share parser, resolver, lookup timeout and error-key
 * mappers moved to `packages/workflows/src/authority/invite-share.ts` (phase 67 plan 05); this path
 * stays so existing imports and tests keep working. Names are re-exported one by one (no `export *`)
 * so a name added to the shared barrel never reaches this app path silently. No logic lives here.
 */

export {
	InviteShareError,
	parseInviteShare,
	serializeInviteShare,
	isInvitationQrText,
	parseInviteExpirationMs,
	isShareExpired,
	resolveInviteFromShare,
	inviteShareErrorKey,
	INVITE_LOOKUP_TIMEOUT_MS,
	INVITE_LOOKUP_TIMEOUT_CODE,
	InviteLookupTimeoutError,
	withInviteLookupTimeout,
	isNetworkNoAnswerError,
	isBiometricCancelError,
	inviteAcceptErrorKey,
	inviteLoadErrorKey,
} from '@votetorrent/workflows/authority';
export type { InviteShareErrorCode, ParsedInviteShare, InviteShareFields } from '@votetorrent/workflows/authority';
