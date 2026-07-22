/**
 * Unit tests for ConfirmationScreen (REG-04/D-05) — the mock Face-ID confirming tap. Fully
 * mocks `@react-navigation/native` (spy-able `popToTop`) and `providers/VotingAppProvider`
 * (spy-able `setIsRegistered`) so both calls — and their relative order — can be asserted
 * without a real navigator/provider tree, mirroring Authority's
 * `NetworksScreen.bootstrap.test.tsx` full-replace mocking pattern.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();
const mockSetIsRegistered = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({popToTop: mockPopToTop}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
		},
		type: {
			h2: {fontSize: 28, lineHeight: 34},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 16, lineHeight: 20},
		},
		radii: {pill: 999},
	}),
}));

jest.mock('../../../providers/VotingAppProvider', () => ({
	useVotingApp: () => ({setIsRegistered: mockSetIsRegistered}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ConfirmationScreen = require('../ConfirmationScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<ConfirmationScreen />);
	});
	return tr;
}

beforeEach(() => {
	mockPopToTop.mockClear();
	mockSetIsRegistered.mockClear();
});

describe('ConfirmationScreen (REG-04/D-05)', () => {
	it("renders the 'You're all set!' heading and the confirm CTA", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("You're all set!");

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
	});

	it('does NOT flip isRegistered or navigate on mount (only on the deliberate press)', () => {
		renderScreen();
		expect(mockSetIsRegistered).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it('pressing the CTA calls setIsRegistered(true) then navigation.popToTop() (D-05 confirming gesture)', () => {
		const tr = renderScreen();
		const callOrder: string[] = [];
		mockSetIsRegistered.mockImplementation(() => callOrder.push('setIsRegistered'));
		mockPopToTop.mockImplementation(() => callOrder.push('popToTop'));

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		renderer.act(() => {
			cta.props.onPress();
		});

		expect(mockSetIsRegistered).toHaveBeenCalledWith(true);
		expect(mockSetIsRegistered).toHaveBeenCalledTimes(1);
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(['setIsRegistered', 'popToTop']);
	});
});
