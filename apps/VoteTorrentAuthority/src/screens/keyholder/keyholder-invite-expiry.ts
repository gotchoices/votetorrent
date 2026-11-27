/**
 * keyholder-invite-expiry.ts: the O-11 validity presets moved to
 * `packages/workflows/src/authority/keyholder-invite-expiry.ts` (phase 67 plan 10). This path stays so every
 * existing import, test and the lean rig's hook import keep working; it is a thin binding with the same
 * export names and no logic.
 */
export {
	KEYHOLDER_INVITE_EXPIRY_HOURS,
	DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS,
	keyholderInviteExpiration,
	keyholderInviteExpiryLabel,
} from '@votetorrent/workflows/authority';
export type { KeyholderInviteExpiryHours } from '@votetorrent/workflows/authority';
