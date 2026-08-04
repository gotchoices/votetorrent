/**
 * Unit tests for DeviceAttestationScreen (REG-02/D-07/D-08/D-10/D-11) — the StrongBox/TEE
 * capability probe interstitial. Fully mocks `@react-navigation/native` (mirrors Authority's
 * `NetworksScreen.bootstrap.test.tsx` full-replace pattern) so `useNavigation().replace` is a
 * spy-able jest.fn() and `useFocusEffect` is a plain `useEffect` wrapper — its cleanup then fires
 * naturally on blur/unmount via React's real effect lifecycle, exactly the behavior Pitfall 4
 * requires, without needing a real `NavigationContainer`.
 *
 * `../../engines/attestation-producer` is mocked so `resolveAttestationProducer()` returns a
 * `{ provisionDeviceKey: jest.fn() }` the test can resolve/reject at will — this suite never
 * touches the real native TurboModule.
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

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({isInitialized: true}),
}));

const mockProvisionDeviceKey = jest.fn();
const mockResolveAttestationProducer = jest.fn((_realProducer?: unknown) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
}));

jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (realProducer?: unknown) => mockResolveAttestationProducer(realProducer),
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

async function flush() {
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe('DeviceAttestationScreen (REG-02/D-07/D-08/D-10/D-11)', () => {
	const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;

	beforeEach(() => {
		mockReplace.mockClear();
		mockProvisionDeviceKey.mockReset();
		mockResolveAttestationProducer.mockClear();
	});

	afterEach(() => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
	});

	it("renders the 'Verifying your device...' heading while the probe is in flight", () => {
		mockProvisionDeviceKey.mockReturnValue(new Promise(() => {})); // never resolves
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Verifying your device');
	});

	it('calls provisionDeviceKey() before navigation.replace on resolve, and advances exactly once', async () => {
		mockProvisionDeviceKey.mockResolvedValue({publicKey: 'P256_PUB'});

		renderScreen();
		await flush();

		expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(1);
		expect(mockReplace).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockReplace).toHaveBeenCalledTimes(1);
	});

	it('terminal-class rejection with __DEV__ false renders the terminal wall and does NOT advance', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = false;
		mockProvisionDeviceKey.mockRejectedValue({code: 'NO_STRONGBOX_OR_TEE'});

		const tr = renderScreen();
		await flush();

		expect(mockReplace).not.toHaveBeenCalled();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("This device can't be used to vote");
	});

	it('terminal-class rejection with __DEV__ true still advances (emulator never blocked)', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		mockProvisionDeviceKey.mockRejectedValue({code: 'NO_STRONGBOX_OR_TEE'});

		renderScreen();
		await flush();

		expect(mockReplace).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockReplace).toHaveBeenCalledTimes(1);
	});

	it('a non-terminal (recoverable) rejection still advances — transient probe hiccups are not a wall', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = false;
		mockProvisionDeviceKey.mockRejectedValue({code: 'PLAY_INTEGRITY_NETWORK'});

		renderScreen();
		await flush();

		expect(mockReplace).toHaveBeenCalledWith('RegisterPersonal');
	});

	it('does not navigate or set state if the screen unmounts before the probe resolves (cleanup guards the async work)', async () => {
		let resolveProbe!: (value: {publicKey: string}) => void;
		mockProvisionDeviceKey.mockReturnValue(
			new Promise(resolve => {
				resolveProbe = resolve;
			}),
		);

		const tr = renderScreen();
		renderer.act(() => {
			tr.unmount();
		});

		resolveProbe({publicKey: 'P256_PUB'});
		await flush();

		expect(mockReplace).not.toHaveBeenCalled();
	});
});
