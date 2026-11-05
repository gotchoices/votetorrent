/**
 * PendingInvitationsSection: lists the officer invitations still awaiting an answer and opens
 * AuthorityDetail with { authorityId, slotCid }. Names only; never a Cid or engine text.
 */
import React from 'react';
import renderer from 'react-test-renderer';

const mockNavigate = jest.fn();
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
let mockGetOfficerInvite: jest.Mock;
const mockGetEngine = jest.fn(async (_name: string) => ({ getOfficerInvite: (cid: string) => mockGetOfficerInvite(cid) }));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../../../providers/AppProvider', () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));
jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		colors: { primary: 'p', background: 'b', card: 'c', text: 't', border: 'bo', notification: 'n', error: 'e', textSecondary: 'ts', important: 'i', success: 's', accent: 'a', warning: 'w' },
	}),
	useNavigation: () => ({ navigate: mockNavigate }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require('react');
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === 'function' ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PendingInvitationsSection } = require('../components/PendingInvitationsSection');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function render(engine: any) {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<PendingInvitationsSection authorityId="a1" authorityEngine={engine} />);
	});
	await flush();
	return tr;
}
async function flush() {
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}
const text = (tr: renderer.ReactTestRenderer) => JSON.stringify(tr.toJSON());
const byId = (tr: renderer.ReactTestRenderer, id: string) => {
	const host = tr.root.findAll((n) => n.props?.testID === id)[0];
	return host.findAll((n) => typeof n.props?.onPress === 'function')[0];
};
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props?.testID === id).length > 0;

beforeEach(() => {
	jest.clearAllMocks();
	mockFocusCallbacks.length = 0;
	mockGetOfficerInvite = jest.fn(async (cid: string) => ({ invite: { name: cid === 'c1' ? 'Bea Two' : 'Cy Three' } }));
});

describe('PendingInvitationsSection', () => {
	it('lists each pending invitation by name and opens AuthorityDetail with its slot', async () => {
		const engine = { getPendingInviteCids: jest.fn(async () => ['c1', 'c2']) };
		const tr = await render(engine);
		expect(text(tr)).toContain('pendingInvitationsHeading');
		expect(text(tr)).toContain('Bea Two');
		expect(text(tr)).toContain('Cy Three');
		expect(hasId(tr, 'pending-invitation-c1')).toBe(true);
		expect(hasId(tr, 'pending-invitation-c2')).toBe(true);
		await renderer.act(async () => {
			byId(tr, 'pending-invitation-c1').props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('AuthorityDetail', { authorityId: 'a1', slotCid: 'c1' });
	});

	it('renders the empty copy without asking for the invitations engine', async () => {
		const tr = await render({ getPendingInviteCids: jest.fn(async () => []) });
		expect(text(tr)).toContain('pendingInvitationsEmpty');
		expect(mockGetEngine).not.toHaveBeenCalled();
	});

	it('shows a load error with a retry that re-reads directly', async () => {
		const getPendingInviteCids = jest
			.fn()
			.mockRejectedValueOnce(new Error('secret engine text'))
			.mockResolvedValueOnce(['c1']);
		const tr = await render({ getPendingInviteCids });
		expect(text(tr)).toContain('pendingInvitationsLoadError');
		expect(text(tr)).not.toContain('secret engine text');
		await renderer.act(async () => {
			byId(tr, 'pending-invitations-retry').props.onPress();
		});
		await flush();
		expect(getPendingInviteCids).toHaveBeenCalledTimes(2);
		expect(hasId(tr, 'pending-invitation-c1')).toBe(true);
	});

	it('shows the shared peer copy for a peer-unavailable failure', async () => {
		const err = Object.assign(new Error('Block b123 is unavailable (cohort-unreachable)'), { name: 'BlockUnavailableError' });
		const tr = await render({
			getPendingInviteCids: jest.fn(async () => {
				throw err;
			}),
		});
		expect(text(tr)).not.toContain('b123');
		expect(text(tr)).toContain('peerReadUnavailableBody');
	});

	it('titles a row (no name) when one name read fails, never the Cid', async () => {
		mockGetOfficerInvite = jest.fn(async (cid: string) => {
			if (cid === 'c1') throw new Error('boom');
			return { invite: { name: 'Cy Three' } };
		});
		const tr = await render({ getPendingInviteCids: jest.fn(async () => ['c1', 'c2']) });
		expect(hasId(tr, 'pending-invitation-c1')).toBe(true);
		expect(text(tr)).toContain('keyholderUnnamed');
		expect(text(tr)).toContain('Cy Three');
	});

	it('re-reads on focus: a cancelled invitation drops its row', async () => {
		const getPendingInviteCids = jest.fn(async () => ['c1', 'c2']);
		const tr = await render({ getPendingInviteCids });
		expect(hasId(tr, 'pending-invitation-c1')).toBe(true);
		getPendingInviteCids.mockImplementation(async () => ['c2']);
		await renderer.act(async () => {
			mockFocusCallbacks[mockFocusCallbacks.length - 1]();
		});
		await flush();
		expect(hasId(tr, 'pending-invitation-c1')).toBe(false);
		expect(hasId(tr, 'pending-invitation-c2')).toBe(true);
	});

	it('with no authority engine yet it stays loading and calls nothing', async () => {
		const tr = await render(null);
		expect(mockGetEngine).not.toHaveBeenCalled();
		expect(hasId(tr, 'pending-invitations-loading')).toBe(true);
	});

	it("WR-R3-02: an authority switch drops the previous authority's rows in the same render", async () => {
		const engineA = { getPendingInviteCids: jest.fn(async () => ['c1']) };
		const tr = await render(engineA);
		expect(hasId(tr, 'pending-invitation-c1')).toBe(true);

		await renderer.act(async () => {
			tr.update(<PendingInvitationsSection authorityId="a2" authorityEngine={null} />);
		});
		await flush();

		expect(hasId(tr, 'pending-invitation-c1')).toBe(false);
		expect(text(tr)).not.toContain('Bea Two');
		expect(hasId(tr, 'pending-invitations-loading')).toBe(true);
	});

	it("WR-R3-02: a load of the previous authority that lands after the switch never shows its rows", async () => {
		let resolveCids!: (cids: string[]) => void;
		const engineA = {
			getPendingInviteCids: jest.fn(
				() =>
					new Promise<string[]>((resolve) => {
						resolveCids = resolve;
					})
			),
		};
		const tr = await render(engineA);
		expect(engineA.getPendingInviteCids).toHaveBeenCalledTimes(1);

		await renderer.act(async () => {
			tr.update(<PendingInvitationsSection authorityId="a2" authorityEngine={null} />);
		});
		await flush();
		await renderer.act(async () => {
			resolveCids(['c1']);
		});
		await flush();

		expect(hasId(tr, 'pending-invitation-c1')).toBe(false);
		expect(text(tr)).not.toContain('Bea Two');
		expect(hasId(tr, 'pending-invitations-loading')).toBe(true);
		expect(mockNavigate).not.toHaveBeenCalled();
	});
});
