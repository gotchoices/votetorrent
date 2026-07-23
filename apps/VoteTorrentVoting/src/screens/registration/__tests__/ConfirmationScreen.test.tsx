/**
 * Unit tests for ConfirmationScreen (REG-04/D-05) — the Face-ID confirming tap. Fully mocks
 * `@react-navigation/native` (spy-able `popToTop`) and `providers/VotingAppProvider` so both can
 * be exercised without a real navigator/provider tree, mirroring Authority's
 * `NetworksScreen.bootstrap.test.tsx` full-replace mocking pattern.
 *
 * Phase 44-07 (D-02): the mock `setIsRegistered` call is REMOVED from `ConfirmationScreen`'s tap
 * handler (see its file header comment) — this test now only asserts the CTA calls
 * `navigation.popToTop()`. Phase 44-08 (the phase's capstone plan) will replace `onConfirm` with
 * the real register/associate ceremony and extend this test accordingly.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();

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
	useVotingApp: () => ({}),
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
});

describe('ConfirmationScreen (REG-04/D-05)', () => {
	it("renders the 'You're all set!' heading and the confirm CTA", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("You're all set!");

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
	});

	it('does NOT navigate on mount (only on the deliberate press)', () => {
		renderScreen();
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it('pressing the CTA calls navigation.popToTop() (D-05 confirming gesture)', () => {
		const tr = renderScreen();

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		renderer.act(() => {
			cta.props.onPress();
		});

		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});
});
