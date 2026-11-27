/**
 * AuthorizationSection — the per-officer SIGN button. With `onSign`, only the viewing officer's
 * own unsigned row is live (an officer can only sign as themself); without it the section keeps
 * its previous inert rendering for callers that have no signing flow.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../i18n';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		dark: false,
		colors: {text: '#T', accent: '#AC', important: '#IM', card: '#CA', border: '#BO', textSecondary: '#TS'},
	}),
}));
const mockGetEngine = jest.fn();
jest.mock('../../providers/AppProvider', () => ({
	useApp: () => ({getEngine: mockGetEngine}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {AuthorizationSection} = require('../AuthorizationSection');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {CustomButton} = require('../CustomButton');

const ADMIN = {
	admin: {officers: [{userId: 'u-me'}, {userId: 'u-other'}]},
};

async function render(props: Record<string, unknown>) {
	mockGetEngine.mockResolvedValue({
		getUser: async (id: string) => ({getSummary: async () => ({id, name: id === 'u-me' ? 'Me' : 'Other'})}),
	});
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorizationSection admin={ADMIN} {...props} />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	// [0] is ADJUST PROPOSAL; then one SIGN button per officer in roster order.
	const buttons = tr.root.findAllByType(CustomButton);
	return {me: buttons[1]!, other: buttons[2]!};
}

describe('AuthorizationSection SIGN', () => {
	it('enables only the viewing officer\'s own button and calls onSign', async () => {
		const onSign = jest.fn();
		const {me, other} = await render({currentUserId: 'u-me', onSign});
		expect(me.props.disabled).toBe(false);
		expect(other.props.disabled).toBe(true);
		me.props.onPress();
		other.props.onPress();
		expect(onSign).toHaveBeenCalledTimes(1);
	});

	it('disables the button while signing and once the officer has signed', async () => {
		const onSign = jest.fn();
		expect((await render({currentUserId: 'u-me', onSign, signing: true})).me.props.disabled).toBe(true);
		expect((await render({currentUserId: 'u-me', onSign, signedOfficerIds: ['u-me']})).me.props.disabled).toBe(true);
	});

	it('keeps the previous inert rendering when no onSign is passed', async () => {
		const {me, other} = await render({});
		expect(me.props.disabled).toBe(false);
		expect(other.props.disabled).toBe(false);
	});
});
