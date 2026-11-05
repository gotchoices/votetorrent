/**
 * keyholder-invite-expiry.ts: O-11 (user decision #9). The sending officer chooses how long a keyholder
 * invitation stays valid. Presets run from 1 hour to 7 days; the engine caps a keyholder invitation at
 * 7 days (plus a few minutes of clock skew), so the largest preset is exactly that cap. The default is 24 hours.
 *
 * The expiry is chosen on the first send only: it is never changed by a resend.
 */

export const KEYHOLDER_INVITE_EXPIRY_HOURS = [1, 12, 24, 72, 168] as const;

export type KeyholderInviteExpiryHours = (typeof KEYHOLDER_INVITE_EXPIRY_HOURS)[number];

export const DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS: KeyholderInviteExpiryHours = 24;

/** ISO expiration for an invitation sent at `nowMs` and valid for a preset number of hours. */
export function keyholderInviteExpiration(nowMs: number, hours: number): string {
	if (!(KEYHOLDER_INVITE_EXPIRY_HOURS as readonly number[]).includes(hours)) {
		throw new RangeError('Keyholder invitation validity must be one of the offered presets');
	}
	return new Date(nowMs + hours * 3_600_000).toISOString();
}

/** Label for one preset: hours below 3 days, days from 3 days up. */
export function keyholderInviteExpiryLabel(hours: number, t: (key: string, options?: { n: number }) => string): string {
	if (hours === 1) return t('keyholderInviteExpiryHour', { n: 1 });
	if (hours < 72) return t('keyholderInviteExpiryHours', { n: hours });
	return t('keyholderInviteExpiryDays', { n: hours / 24 });
}
