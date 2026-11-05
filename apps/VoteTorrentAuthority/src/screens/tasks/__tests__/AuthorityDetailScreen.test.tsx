/**
 * AuthorityDetailScreen: Cancel / Resend never report a false success and never show engine text.
 *
 * D1-D3 run over the REAL AuthorityEngine (real schema via the vote-engine test fixture); D4-D6 use a
 * fake engine to pin the generic-failure mapping and the log contents.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { InvitationEngine } from '@votetorrent/vote-engine/rn';
import type { Signature, User } from '@votetorrent/vote-core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestNetwork, addTestAuthority, makeTestSignCallback } = require('@votetorrent/vote-engine/test/fixtures/test-context') as {
	createTestNetwork: (overrides?: unknown) => Promise<unknown>;
	addTestAuthority: (net: unknown) => Promise<{
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		authorityEngine: any;
		ctx: { db: AnyDb; user: User };
		user: User;
	}>;
	makeTestSignCallback: (user: User) => (digest: Uint8Array) => Promise<Signature>;
};

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
let mockRouteParams: Partial<{ authorityId: string; slotCid: string }> | undefined = { authorityId: 'a1', slotCid: 'x' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockEngine: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockInvitations: any;
const mockGetEngine = jest.fn(async (name: string) => (name === 'invitations' ? mockInvitations : mockEngine));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../providers/SettingsProvider', () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));
jest.mock('../../../providers/AppProvider', () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));
jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		colors: {
			primary: '#007AFF',
			background: '#FFFFFF',
			card: '#F2F2F7',
			text: '#000000',
			border: '#C6C6C8',
			notification: '#FF3B30',
			error: '#FF3B30',
			textSecondary: '#888888',
			important: '#FF9500',
			success: '#34C759',
			accent: '#00AA00',
		},
	}),
	useRoute: () => ({ params: mockRouteParams }),
	useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: mockSetOptions }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require('../AuthorityDetailScreen');
const AuthorityDetailScreen = ScreenModule.default;

async function render() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailScreen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	return tr;
}

function button(tr: renderer.ReactTestRenderer, testID: string) {
	return tr.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onPress === 'function')[0];
}

async function press(tr: renderer.ReactTestRenderer, testID: string) {
	await renderer.act(async () => {
		await button(tr, testID).props.onPress();
	});
}

function allText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

async function realChain() {
	const net = await createTestNetwork();
	const auth = await addTestAuthority(net);
	const authority = auth.authorityEngine;
	const invitation = new InvitationEngine(auth.ctx);
	const sign = makeTestSignCallback(auth.user);
	const s = authority.createOfficerInvite({ name: 'Olive', title: 'Member', scopes: ['rad'] });
	await authority.saveInviteWithSigning(s, 'rad', sign);
	const row = await auth.ctx.db.prepare("select Cid from InviteSlot where InviteKey = :inviteKey and Type = 'of'").get({ inviteKey: s.inviteKey });
	const original = row!.Cid as string;
	const count = async (sql: string, binds: Record<string, unknown>) => Number((await auth.ctx.db.prepare(sql).get(binds))!.n);
	return { auth, authority, invitation, s, original, count };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockInvitations = { getOfficerInvite: jest.fn(async () => undefined) };
});

describe('AuthorityDetailScreen over the real AuthorityEngine', () => {
	async function answeredChain() {
		const f = await realChain();
		const head = await f.authority.resendInvite(f.original);
		await f.invitation.respondToInvite(head, true, f.s.invitePrivate);
		mockEngine = f.authority;
		mockRouteParams = { authorityId: 'a1', slotCid: f.original };
		return { ...f, head };
	}

	it('D1: Cancel on an answered chain does not navigate back, shows the translated copy, disables both buttons, writes no marker', async () => {
		const f = await answeredChain();
		const tr = await render();
		await press(tr, 'authority-detail-cancel');
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(allText(tr)).toContain('authorityDetailAlreadyAnswered');
		expect(allText(tr)).not.toContain('AuthorityEngine');
		expect(allText(tr)).not.toContain('already been answered');
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(true);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(true);
		expect(await f.count('select count(*) as n from InviteCancellation where SlotCid = :slotCid', { slotCid: f.original })).toBe(0);
		expect(await f.count('select count(*) as n from InviteCancellation where SlotCid = :slotCid', { slotCid: f.head })).toBe(0);
	});

	it('D2: Resend on an answered chain shows the same copy, does not navigate back and adds no slot', async () => {
		const f = await answeredChain();
		const tr = await render();
		await press(tr, 'authority-detail-resend');
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(allText(tr)).toContain('authorityDetailAlreadyAnswered');
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(true);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(true);
		expect(await f.count('select count(*) as n from InviteSlot where InviteKey = :inviteKey', { inviteKey: f.s.inviteKey })).toBe(2);
	});

	it('D3 positive control: Cancel on an unanswered invitation navigates back and writes the marker', async () => {
		const f = await realChain();
		mockEngine = f.authority;
		mockRouteParams = { authorityId: 'a1', slotCid: f.original };
		const tr = await render();
		await press(tr, 'authority-detail-cancel');
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(allText(tr)).not.toContain('authorityDetailAlreadyAnswered');
		expect(allText(tr)).not.toContain('authorityDetailActionFailed');
		expect(await f.count('select count(*) as n from InviteCancellation where SlotCid = :slotCid', { slotCid: f.original })).toBe(1);
	});
});

describe('AuthorityDetailScreen generic failures (fake engine)', () => {
	it('D4: a cancel failure shows the fixed copy, never the engine text, and keeps the buttons enabled', async () => {
		mockEngine = {
			cancelInvite: jest.fn(async () => {
				throw new Error('AuthorityEngine.cancelInvite: InviteSlot not found: abc');
			}),
			resendInvite: jest.fn(),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, 'authority-detail-cancel');
		expect(allText(tr)).toContain('authorityDetailActionFailed');
		expect(allText(tr)).not.toContain('InviteSlot not found');
		expect(allText(tr)).not.toContain('abc');
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(false);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it('D5: a resend failure shows the fixed copy and keeps the buttons enabled', async () => {
		mockEngine = {
			cancelInvite: jest.fn(),
			resendInvite: jest.fn(async () => {
				throw new Error('boom internal detail');
			}),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, 'authority-detail-resend');
		expect(allText(tr)).toContain('authorityDetailActionFailed');
		expect(allText(tr)).not.toContain('boom internal detail');
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(false);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it('D6: console.warn receives a fixed string and the error class name, never the message', async () => {
		class WeirdError extends Error {
			constructor(m: string) {
				super(m);
				this.name = 'WeirdError';
			}
		}
		mockEngine = {
			cancelInvite: jest.fn(async () => {
				throw new WeirdError('secret-cid-123');
			}),
			resendInvite: jest.fn(),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, 'authority-detail-cancel');
		expect(warn).toHaveBeenCalledTimes(1);
		const args = warn.mock.calls[0];
		expect(args).toEqual(['authorityDetail-cancelInvitation failed', 'WeirdError']);
		expect(JSON.stringify(args)).not.toContain('secret-cid-123');
	});
});

describe('AuthorityDetailScreen params, invitee and refusals', () => {
	it('E1: without params it renders the missing-invitation error and calls no engine', async () => {
		mockRouteParams = undefined;
		const tr = await render();
		expect(allText(tr)).toContain('authorityDetailMissingInvitation');
		expect(tr.root.findAll((n) => n.props?.testID === 'authority-detail-missing').length).toBeGreaterThan(0);
		expect(mockGetEngine).not.toHaveBeenCalled();
	});

	it('E2: params without slotCid render the same error', async () => {
		mockRouteParams = { authorityId: 'a1' };
		const tr = await render();
		expect(allText(tr)).toContain('authorityDetailMissingInvitation');
		expect(mockGetEngine).not.toHaveBeenCalled();
	});

	it('E3: shows who was invited', async () => {
		mockEngine = { cancelInvite: jest.fn(), resendInvite: jest.fn() };
		mockInvitations = { getOfficerInvite: jest.fn(async () => ({ invite: { name: 'Olive' } })) };
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		const tr = await render();
		expect(allText(tr)).toContain('authorityDetailInviteeLabel');
		expect(allText(tr)).toContain('Olive');
	});

	it('E4: a failed name read shows no name, logs nothing and leaves the actions enabled', async () => {
		mockEngine = { cancelInvite: jest.fn(), resendInvite: jest.fn() };
		mockInvitations = {
			getOfficerInvite: jest.fn(async () => {
				throw new Error('engine detail');
			}),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});
		const tr = await render();
		expect(allText(tr)).not.toContain('authorityDetailInviteeLabel');
		expect(allText(tr)).not.toContain('engine detail');
		expect(warn).toHaveBeenCalledTimes(0);
		expect(error).toHaveBeenCalledTimes(0);
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(false);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(false);
	});

	it.each(['cancel', 'resend'])('E5: %s refused with invite-not-authorized shows the rule and disables both buttons', async (which) => {
		const refuse = jest.fn(async () => {
			throw Object.assign(new Error('AuthorityEngine: not allowed'), { code: 'invite-not-authorized' });
		});
		mockEngine = { cancelInvite: which === 'cancel' ? refuse : jest.fn(), resendInvite: which === 'resend' ? refuse : jest.fn() };
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, `authority-detail-${which}`);
		expect(allText(tr)).toContain('authorityDetailNotAuthorized');
		expect(allText(tr)).not.toContain('not allowed');
		expect(button(tr, 'authority-detail-cancel').props.disabled).toBe(true);
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(true);
	});

	it('E6: invite-type-not-resendable shows the generic failure and keeps buttons enabled', async () => {
		mockEngine = {
			cancelInvite: jest.fn(),
			resendInvite: jest.fn(async () => {
				throw Object.assign(new Error('x'), { code: 'invite-type-not-resendable' });
			}),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, 'authority-detail-resend');
		expect(allText(tr)).toContain('authorityDetailActionFailed');
		expect(button(tr, 'authority-detail-resend').props.disabled).toBe(false);
	});

	it('E7: a peer-unavailable write failure shows the shared write copy', async () => {
		mockEngine = {
			cancelInvite: jest.fn(async () => {
				throw Object.assign(new Error('Block b123 is unavailable (cohort-unreachable)'), { name: 'BlockUnavailableError' });
			}),
			resendInvite: jest.fn(),
		};
		mockRouteParams = { authorityId: 'a1', slotCid: 'abc' };
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		const tr = await render();
		await press(tr, 'authority-detail-cancel');
		expect(allText(tr)).toContain('peerWriteUnavailable');
		expect(allText(tr)).not.toContain('b123');
	});
});
