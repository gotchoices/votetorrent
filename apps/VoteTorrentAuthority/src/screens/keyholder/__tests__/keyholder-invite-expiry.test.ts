import {
	DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS,
	KEYHOLDER_INVITE_EXPIRY_HOURS,
	keyholderInviteExpiration,
	keyholderInviteExpiryLabel,
} from '../keyholder-invite-expiry';

describe('keyholder invite expiry presets', () => {
	it('offers 1 h, 12 h, 24 h, 3 d and 7 d, defaulting to 24 h', () => {
		expect([...KEYHOLDER_INVITE_EXPIRY_HOURS]).toEqual([1, 12, 24, 72, 168]);
		expect(DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS).toBe(24);
	});

	it('the largest preset is exactly 7 days (the engine cap)', () => {
		expect(Math.max(...KEYHOLDER_INVITE_EXPIRY_HOURS)).toBe(7 * 24);
	});

	it('computes the ISO expiration as now plus the chosen hours', () => {
		const now = Date.UTC(2026, 9, 8, 12, 0, 0);
		expect(keyholderInviteExpiration(now, 24)).toBe(new Date(now + 24 * 3_600_000).toISOString());
		expect(keyholderInviteExpiration(now, 168)).toBe(new Date(now + 168 * 3_600_000).toISOString());
	});

	it('refuses an hours value that is not a preset', () => {
		expect(() => keyholderInviteExpiration(0, 5)).toThrow();
		expect(() => keyholderInviteExpiration(0, 200)).toThrow();
	});

	it('labels hours and days with the right key and count', () => {
		const t = jest.fn((key: string, o?: { n: number }) => `${key}:${o?.n}`);
		expect(keyholderInviteExpiryLabel(1, t)).toBe('keyholderInviteExpiryHour:1');
		expect(keyholderInviteExpiryLabel(12, t)).toBe('keyholderInviteExpiryHours:12');
		expect(keyholderInviteExpiryLabel(24, t)).toBe('keyholderInviteExpiryHours:24');
		expect(keyholderInviteExpiryLabel(72, t)).toBe('keyholderInviteExpiryDays:3');
		expect(keyholderInviteExpiryLabel(168, t)).toBe('keyholderInviteExpiryDays:7');
	});
});
