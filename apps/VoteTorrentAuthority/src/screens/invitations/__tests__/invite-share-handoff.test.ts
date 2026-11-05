import { stashInviteShare, takeInviteShare } from '../invite-share-handoff';

describe('invite-share-handoff', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('returns an opaque token that does not contain the text', () => {
		const text = 'ab'.repeat(32);
		const token = stashInviteShare(text);
		expect(typeof token).toBe('string');
		expect(token).not.toContain(text);
		expect(token).not.toContain('ab'.repeat(8));
	});
	it('hands the text over once, then forgets it', () => {
		const token = stashInviteShare('secret-share');
		expect(takeInviteShare(token)).toBe('secret-share');
		expect(takeInviteShare(token)).toBeUndefined();
	});
	it('an unknown or missing token yields undefined', () => {
		expect(takeInviteShare('nope')).toBeUndefined();
		expect(takeInviteShare(undefined)).toBeUndefined();
	});
	it('purges an entry older than 120 s', () => {
		const old = stashInviteShare('old-share');
		jest.advanceTimersByTime(121_000);
		const fresh = stashInviteShare('fresh-share');
		expect(takeInviteShare(old)).toBeUndefined();
		expect(takeInviteShare(fresh)).toBe('fresh-share');
	});
	it('does not log', () => {
		const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
		takeInviteShare(stashInviteShare('quiet'));
		spies.forEach((s) => {
			expect(s).not.toHaveBeenCalled();
			s.mockRestore();
		});
	});
});
