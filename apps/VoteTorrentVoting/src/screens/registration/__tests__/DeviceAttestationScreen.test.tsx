/**
 * Unit tests for DeviceAttestationScreen (REG-02/D-07/D-08) — the timed auto-advance
 * interstitial. Fully mocks `@react-navigation/native` (mirrors Authority's
 * `NetworksScreen.bootstrap.test.tsx` full-replace pattern) so `useNavigation().replace` is a
 * spy-able jest.fn() and `useFocusEffect` is a plain `useEffect` wrapper — its cleanup then
 * fires naturally on blur/unmount via React's real effect lifecycle, exactly the behavior
 * Pitfall 4 requires, without needing a real `NavigationContainer`. Drives the 2.5s timer with
 * Jest fake timers per 41-RESEARCH.md's Code Examples ("Testing the timed auto-advance with fake
 * timers").
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockReplace = jest.fn();

jest.mock('@react-navigation/native', () => {
	const actualReact = require('react');
	return {
		useNavigation: () => ({replace: mockReplace}),
		// Plain useEffect wrapper — cleanup fires on blur/unmount identically to the real
		// useFocusEffect's contract for this test's purposes (Pitfall 4).
		useFocusEffect: (cb: () => (() => void) | void) => {
			actualReact.useEffect(() => cb(), [cb]);
		},
		useTheme: () => ({
			colors: {
				primary: '#2196f3',
				background: '#fbfbfb',
				text: '#000000',
				textSecondary: '#7d7d7d',
			},
			fonts: {
				regular: {fontFamily: 'System', fontWeight: '400'},
				medium: {fontFamily: 'System', fontWeight: '500'},
			},
			type: {
				h2: {fontSize: 28, lineHeight: 34},
				caption: {fontSize: 16, lineHeight: 20},
			},
		}),
	};
});

jest.mock('../../../providers/VotingAppProvider', () => ({
	useVotingApp: () => ({isInitialized: true}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DeviceAttestationScreen = require('../DeviceAttestationScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<DeviceAttestationScreen />);
	});
	return tr;
}

describe('DeviceAttestationScreen (REG-02/D-07/D-08)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockReplace.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("renders the 'Verifying your device...' heading", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Verifying your device');
	});

	it('auto-advances to RegisterPersonal after ~2.5s (D-08) and does not double-navigate', () => {
		renderScreen();

		renderer.act(() => {
			jest.advanceTimersByTime(2500);
		});
		expect(mockReplace).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockReplace).toHaveBeenCalledTimes(1);

		// advancing time further does not fire again — exactly once, no repeat firing
		renderer.act(() => {
			jest.advanceTimersByTime(5000);
		});
		expect(mockReplace).toHaveBeenCalledTimes(1);
	});

	it('does not navigate if the screen unmounts before the timer fires (cleanup clears the timeout)', () => {
		const tr = renderScreen();

		renderer.act(() => {
			tr.unmount();
		});
		renderer.act(() => {
			jest.advanceTimersByTime(5000);
		});
		expect(mockReplace).not.toHaveBeenCalled();
	});
});
