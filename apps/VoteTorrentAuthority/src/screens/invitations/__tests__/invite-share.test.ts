import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { InvitationEngine } from '@votetorrent/vote-engine/rn';
import { addTestAuthority, createTestNetwork, makeTestSignCallback } from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { InviteSlotResolution } from '@votetorrent/vote-core';
import { InviteShareError, inviteAcceptErrorKey, inviteLoadErrorKey, inviteShareErrorKey, isShareExpired, parseInviteExpirationMs, parseInviteShare, resolveInviteFromShare } from '../invite-share';

function kp() {
	const priv = secp256k1.utils.randomSecretKey();
	return { invitePrivate: bytesToHex(priv), inviteKey: bytesToHex(secp256k1.getPublicKey(priv)) };
}
/** Engine stub: resolver plus the three status getters (default: slot present, unanswered). */
function eng(resolve: (...a: any[]) => Promise<InviteSlotResolution>, status: unknown = { invite: {}, result: undefined }) {
	const get = jest.fn(async () => status);
	return { resolveInviteSlot: resolve, getKeyholderInvite: get, getOfficerInvite: get, getAuthorityInvite: get } as any;
}
function share(over: Record<string, unknown> = {}) {
	const k = kp();
	return { k, text: JSON.stringify({ ...k, expiration: 'x', type: 'k', name: 'Ada Secret', ...over }) };
}

describe('parseInviteShare', () => {
	it('parses the onSend JSON share', () => {
		const { k, text } = share();
		expect(parseInviteShare(`  ${text}\n`)).toEqual({ invitePrivate: k.invitePrivate, inviteKey: k.inviteKey, type: 'k', name: 'Ada Secret', expiration: 'x' });
	});
	it('parses a raw 64-hex private key with no type', () => {
		const k = kp();
		expect(parseInviteShare(` ${k.invitePrivate} `)).toEqual({ invitePrivate: k.invitePrivate, inviteKey: k.inviteKey });
	});
	it('rejects malformed input', () => {
		const k = kp();
		expect(parseInviteShare('')).toBeUndefined();
		expect(parseInviteShare('not json')).toBeUndefined();
		expect(parseInviteShare('zz'.repeat(32))).toBeUndefined();
		expect(parseInviteShare('ab'.repeat(31))).toBeUndefined();
		expect(parseInviteShare(JSON.stringify({ invitePrivate: 'ab'.repeat(31) }))).toBeUndefined();
		expect(parseInviteShare(JSON.stringify({ invitePrivate: k.invitePrivate, inviteKey: kp().inviteKey }))).toBeUndefined();
	});
});

describe('resolveInviteFromShare', () => {
	it('malformed', async () => {
		const resolve = jest.fn();
		await expect(resolveInviteFromShare(eng(resolve), 'junk', 'k')).rejects.toMatchObject({ code: 'malformed' });
		expect(resolve).not.toHaveBeenCalled();
	});
	it('wrong-type without calling the resolver', async () => {
		const resolve = jest.fn();
		const { text } = share({ type: 'of' });
		await expect(resolveInviteFromShare(eng(resolve), text, 'k')).rejects.toMatchObject({ code: 'wrong-type' });
		expect(resolve).not.toHaveBeenCalled();
	});
	it('not-found with fixed message that leaks neither key nor name', async () => {
		const { k, text } = share();
		const err = await resolveInviteFromShare(eng(async () => ({ status: 'not-found' })), text, 'k').catch((e) => e);
		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('not-found');
		expect(err.message).not.toContain(k.inviteKey);
		expect(err.message).not.toContain('Ada Secret');
	});
	it('success', async () => {
		const { k, text } = share();
		const resolve = jest.fn(async (): Promise<InviteSlotResolution> => ({ status: 'live', cid: 'cid-1' }));
		const out = await resolveInviteFromShare(eng(resolve), text, 'k');
		expect(out.slotCid).toBe('cid-1');
		expect(out.invitePrivate).toBe(k.invitePrivate);
		expect(resolve).toHaveBeenCalledWith(k.inviteKey, 'k');
	});
});

describe('resolveInviteFromShare answered-slot refusal', () => {
	it.each([
		['k', 'getKeyholderInvite'],
		['of', 'getOfficerInvite'],
		['au', 'getAuthorityInvite'],
	] as const)('%s: an answered slot rejects already-answered (accepted or declined)', async (type, getter) => {
		for (const isAccepted of [true, false]) {
			const { text } = share({ type });
			const e = eng(async () => ({ status: 'live', cid: 'cid-1' }), { invite: {}, result: { isAccepted, invitationSignature: 's' } });
			await expect(resolveInviteFromShare(e, text, type)).rejects.toMatchObject({ code: 'already-answered' });
			expect(e[getter]).toHaveBeenCalledWith('cid-1');
		}
	});
	it('a pending slot still resolves', async () => {
		const { text } = share({ type: 'of' });
		await expect(resolveInviteFromShare(eng(async () => ({ status: 'live', cid: 'cid-2' })), text, 'of')).resolves.toMatchObject({ slotCid: 'cid-2' });
	});
});

describe('resolveInviteFromShare resolution statuses', () => {
	it('answered -> already-answered without needing the status read', async () => {
		const { text } = share();
		const e = eng(async () => ({ status: 'answered', cid: 'c1' }));
		await expect(resolveInviteFromShare(e, text, 'k')).rejects.toMatchObject({ code: 'already-answered' });
		expect(e.getKeyholderInvite).not.toHaveBeenCalled();
	});
	it('no-longer-valid -> distinct code, key and a fixed message', async () => {
		const { k, text } = share();
		const err = await resolveInviteFromShare(eng(async () => ({ status: 'no-longer-valid' })), text, 'k').catch((e) => e);
		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('no-longer-valid');
		expect(inviteShareErrorKey(err)).toBe('invitationAcceptNoLongerValid');
		expect(err.message).toBe('Invitation was withdrawn or has expired');
		expect(err.message).not.toContain(k.inviteKey);
		expect(err.message).not.toContain('Ada Secret');
	});
	it.each(['not-found', 'ambiguous'] as const)('%s -> not-found', async (status) => {
		const { text } = share();
		await expect(resolveInviteFromShare(eng(async () => ({ status })), text, 'k')).rejects.toMatchObject({ code: 'not-found' });
	});
	it('an unknown future status fails closed', async () => {
		const { text } = share();
		await expect(resolveInviteFromShare(eng(async () => ({ status: 'brand-new' }) as never), text, 'k')).rejects.toBeInstanceOf(InviteShareError);
	});
});

describe('resolveInviteFromShare over a real InvitationEngine (CR-01 / CR-02)', () => {
	async function fixture() {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const authority = auth.authorityEngine as any;
		const invitation = new InvitationEngine(auth.ctx);
		const sign = makeTestSignCallback(auth.user);
		const send = async (name: string) => {
			const s = authority.createOfficerInvite({ name, title: 'Member', scopes: ['rad'] });
			await authority.saveInviteWithSigning(s, 'rad', sign);
			const row = await auth.ctx.db.prepare("select Cid from InviteSlot where InviteKey = :k and Type = 'of'").get({ k: s.inviteKey });
			const text = JSON.stringify({ invitePrivate: s.invitePrivate, inviteKey: s.inviteKey, type: 'of', name });
			return { text, cid: row!.Cid as string };
		};
		return { authority, invitation, send };
	}

	it('send -> resolves to the original slot', async () => {
		const f = await fixture();
		const s = await f.send('Olive');
		await expect(resolveInviteFromShare(f.invitation, s.text, 'of')).resolves.toMatchObject({ slotCid: s.cid });
	});
	it('send -> resend -> resolves to the resend chain head (CR-01)', async () => {
		const f = await fixture();
		const s = await f.send('Olive');
		const head = await f.authority.resendInvite(s.cid);
		expect(head).not.toBe(s.cid);
		await expect(resolveInviteFromShare(f.invitation, s.text, 'of')).resolves.toMatchObject({ slotCid: head });
	});
	it('send -> cancel -> no-longer-valid (CR-02)', async () => {
		const f = await fixture();
		const s = await f.send('Olive');
		await f.authority.cancelInvite(s.cid);
		await expect(resolveInviteFromShare(f.invitation, s.text, 'of')).rejects.toMatchObject({ code: 'no-longer-valid' });
	});
	it('send -> resend -> cancel ORIGINAL -> no-longer-valid', async () => {
		const f = await fixture();
		const s = await f.send('Olive');
		await f.authority.resendInvite(s.cid);
		await f.authority.cancelInvite(s.cid);
		await expect(resolveInviteFromShare(f.invitation, s.text, 'of')).rejects.toMatchObject({ code: 'no-longer-valid' });
	});
});

describe('inviteShareErrorKey', () => {
	it('maps codes and ignores other errors', () => {
		expect(inviteShareErrorKey(new InviteShareError('malformed'))).toBe('invitationAcceptMalformed');
		expect(inviteShareErrorKey(new InviteShareError('wrong-type'))).toBe('invitationAcceptWrongType');
		expect(inviteShareErrorKey(new InviteShareError('not-found'))).toBe('invitationAcceptNotFound');
		expect(inviteShareErrorKey(new InviteShareError('already-answered'))).toBe('invitationAcceptAlreadyAnswered');
		expect(inviteShareErrorKey(new Error('x'))).toBeUndefined();
	});
});

describe('invite expiration (UTC reads)', () => {
	const prevTz = process.env.TZ;
	beforeAll(() => {
		process.env.TZ = 'Asia/Kathmandu';
	});
	afterAll(() => {
		if (prevTz === undefined) delete process.env.TZ;
		else process.env.TZ = prevTz;
	});
	it('reads a designator-less value as UTC regardless of the local zone', () => {
		expect(parseInviteExpirationMs('2026-10-06T08:49:05.107')).toBe(Date.UTC(2026, 9, 6, 8, 49, 5, 107));
	});
	it('honours Z and explicit offsets', () => {
		expect(parseInviteExpirationMs('2026-10-06T08:49:05.107Z')).toBe(Date.UTC(2026, 9, 6, 8, 49, 5, 107));
		expect(parseInviteExpirationMs('2026-10-06T08:49:05+05:45')).toBe(Date.UTC(2026, 9, 6, 3, 4, 5));
		expect(parseInviteExpirationMs('2026-10-06T08:49:05-06:00')).toBe(Date.UTC(2026, 9, 6, 14, 49, 5));
	});
	it('returns undefined for garbage', () => {
		expect(parseInviteExpirationMs('nope')).toBeUndefined();
		expect(parseInviteExpirationMs('')).toBeUndefined();
	});
	it('parseInviteShare keeps a string expiration and ignores a non-string', () => {
		const k = kp();
		expect(parseInviteShare(JSON.stringify({ ...k, expiration: '2026-10-06T08:49:05' }))?.expiration).toBe('2026-10-06T08:49:05');
		const p = parseInviteShare(JSON.stringify({ ...k, expiration: 5 }));
		expect(p).toBeDefined();
		expect(p?.expiration).toBeUndefined();
		expect(parseInviteShare(JSON.stringify(k))?.expiration).toBeUndefined();
	});
	it('isShareExpired is true only for a parsed expiration at or before now', () => {
		const base = { invitePrivate: 'a', inviteKey: 'b' };
		const at = Date.UTC(2026, 9, 6, 8, 49, 5);
		expect(isShareExpired({ ...base, expiration: '2026-10-06T08:49:05' }, at)).toBe(true);
		expect(isShareExpired({ ...base, expiration: '2026-10-06T08:49:05' }, at - 1)).toBe(false);
		expect(isShareExpired({ ...base, expiration: 'garbage' }, at)).toBe(false);
		expect(isShareExpired(base, at)).toBe(false);
	});
});

describe('resolveInviteFromShare returns the status it read', () => {
	it('carries the status of the one engine read', async () => {
		const { text } = share();
		const status = { invite: { name: 'Kay Two' }, result: undefined };
		const e = eng(async () => ({ status: 'live', cid: 'cid-9' }), status);
		const out = await resolveInviteFromShare(e, text, 'k');
		expect(out.status).toBe(status);
		expect(e.getKeyholderInvite).toHaveBeenCalledTimes(1);
	});
});

describe('inviteAcceptErrorKey', () => {
	const coded = (code: string) => Object.assign(new Error('x'), { code });
	it.each([
		['invite-already-answered', 'invitationAcceptAlreadyAnswered'],
		['invite-no-longer-valid', 'invitationAcceptNoLongerValid'],
		['invite-superseded', 'invitationAcceptSuperseded'],
		['invite-unverifiable', 'invitationAcceptNotFound'],
		['self-invite', 'keyholderAcceptSelfInvite'],
		['seat-already-held', 'keyholderAcceptSeatHeld'],
	])('engine code %s -> %s', (code, key) => {
		expect(inviteAcceptErrorKey(coded(code))).toBe(key);
	});
	it('maps share errors like inviteShareErrorKey', () => {
		expect(inviteAcceptErrorKey(new InviteShareError('wrong-type'))).toBe('invitationAcceptWrongType');
		expect(inviteAcceptErrorKey(new InviteShareError('malformed'))).toBe('invitationAcceptMalformed');
	});
	it('anything else is undefined', () => {
		expect(inviteAcceptErrorKey(coded('boom'))).toBeUndefined();
		expect(inviteAcceptErrorKey(new Error('plain'))).toBeUndefined();
		expect(inviteAcceptErrorKey('str')).toBeUndefined();
		expect(inviteAcceptErrorKey(undefined)).toBeUndefined();
	});
});

describe('inviteLoadErrorKey', () => {
	it('keeps the specific copy for share and coded refusals', () => {
		expect(inviteLoadErrorKey(new InviteShareError('not-found'))).toBe('invitationAcceptNotFound');
		expect(inviteLoadErrorKey(Object.assign(new Error('x'), { code: 'invite-superseded' }))).toBe('invitationAcceptSuperseded');
	});
	it('a no-network error asks for a network, anything else is a load failure', () => {
		expect(inviteLoadErrorKey(Object.assign(new Error('n'), { noNetworkEstablished: true }))).toBe('invitationNeedsNetwork');
		expect(inviteLoadErrorKey(new Error('boom'))).toBe('invitationLoadFailed');
		expect(inviteLoadErrorKey(undefined)).toBe('invitationLoadFailed');
	});
});
