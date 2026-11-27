/**
 * AddDeviceScreen.test.tsx — 57-17/57-18 gap closure (UAT-10 scroll-container regression guard).
 *
 * No test file existed for this screen before this file. `AddDeviceScreen.tsx` uses the
 * pinned-footer sub-case (57-17-SUMMARY.md): the outer root is a plain `View` containing a
 * `ScrollView` (the QR/multiaddress/token content) as a SIBLING of the `Footer`/DONE button,
 * which must stay OUTSIDE the scrollable area. This test asserts the RENDERED `RCTScrollView`
 * host node inside that root — mirroring
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx, the
 * canonical model for this gap class — not source text, since a source grep would also pass on
 * an imported-but-unrendered ScrollView.
 *
 * Also covers the real-data contract: the connection details come from
 * `IUserEngine.connectDevice()` (mocked at the `useApp().getEngine` boundary), never hardcoded,
 * and the phase-gated `FeatureNotAvailableError` renders an honest unavailable state.
 */
import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
	useTranslation: () => ({t: (key: string) => key}),
}));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockConnectDevice = jest.fn();

jest.mock('../../../providers/AppProvider', () => ({
	useApp: () => ({getEngine: mockGetEngine}),
}));
const mockGetEngine = jest.fn(async (name: string) => {
	if (name !== 'user') throw new Error(`unexpected engine ${name}`);
	return {connectDevice: mockConnectDevice};
});

jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		colors: {
			primary: 'sentinel-primary',
			background: 'sentinel-background',
			card: 'sentinel-card',
			text: 'sentinel-text',
			border: 'sentinel-border',
			notification: 'sentinel-notification',
			error: 'sentinel-error',
			textSecondary: 'sentinel-textSecondary',
			important: 'sentinel-important',
			success: 'sentinel-success',
			accent: 'sentinel-accent',
			warning: 'sentinel-warning',
			dark: 'sentinel-dark',
			light: 'sentinel-light',
		},
	}),
	useNavigation: () => ({navigate: mockNavigate, goBack: mockGoBack, setOptions: jest.fn()}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AddDeviceModule = require('../AddDeviceScreen');
const AddDeviceScreen = AddDeviceModule.default ?? AddDeviceModule.AddDeviceScreen;

type TreeNode = {
	type: string;
	props: Record<string, unknown>;
	children: Array<TreeNode | string> | null;
};

function findHostNodeByType(json: unknown, targetType: string): TreeNode | null {
	if (json === null || json === undefined) return null;
	const nodes: unknown[] = Array.isArray(json) ? json : [json];
	for (const node of nodes) {
		if (node === null || typeof node !== 'object') continue;
		const typed = node as TreeNode;
		if (typed.type === targetType) {
			return typed;
		}
		if (typed.children) {
			const found = findHostNodeByType(typed.children, targetType);
			if (found) return found;
		}
	}
	return null;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {FeatureNotAvailableError} = require('@votetorrent/vote-core');

async function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AddDeviceScreen />);
	});
	return tr;
}

const textOf = (tr: renderer.ReactTestRenderer) => JSON.stringify(tr.toJSON());

beforeEach(() => {
	jest.clearAllMocks();
	// The engine's actual behaviour today: the call is phase-gated.
	mockConnectDevice.mockImplementation(async () => {
		throw new FeatureNotAvailableError('connectDevice — requires a paired device (P2P not available)');
	});
});

describe('AddDeviceScreen — scroll container regression guard (57-17/57-18)', () => {
	it('Test 1: renders a real RCTScrollView host node wrapping the QR/multiaddress/token content', async () => {
		mockConnectDevice.mockResolvedValue({multiAddress: '/dns4/peer.example/tcp/443/wss', token: 'real-token'});
		const tr = await renderScreen();
		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('Test 2 (anti-vacuity): the walker returns null against a View-only synthetic tree', () => {
		const syntheticTree = {
			type: 'View',
			props: {},
			children: [
				{type: 'View', props: {}, children: null},
				{type: 'View', props: {}, children: [{type: 'View', props: {}, children: null}]},
			],
		};
		expect(findHostNodeByType(syntheticTree, 'RCTScrollView')).toBeNull();
	});

	it('Test 3: the DONE footer button stays reachable and goes back — it never claims a device was added', async () => {
		const tr = await renderScreen();
		const doneButton = tr.root.findAll(node => node.props?.title === 'done' && typeof node.props?.onPress === 'function');
		expect(doneButton.length).toBeGreaterThan(0);

		renderer.act(() => {
			doneButton[0].props.onPress();
		});
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(mockNavigate).not.toHaveBeenCalled();
	});
});

describe('AddDeviceScreen — connection details come from IUserEngine.connectDevice()', () => {
	it('the phase-gated engine (FeatureNotAvailableError) renders the unavailable state and NO connection details', async () => {
		const tr = await renderScreen();
		expect(mockConnectDevice).toHaveBeenCalledTimes(1);
		expect(tr.root.findAllByProps({testID: 'add-device-unavailable'}).length).toBeGreaterThan(0);
		const text = textOf(tr);
		expect(text).toContain('connectDeviceUnavailable');
		expect(text).not.toContain('qrInformation');
		expect(text).not.toContain('multiaddress');
	});

	it('renders exactly the multiaddress and token the engine returns', async () => {
		mockConnectDevice.mockResolvedValue({multiAddress: '/dns4/peer.example/tcp/443/wss/p2p/12D3KooW', token: 'one-time-token-42'});
		const tr = await renderScreen();
		const text = textOf(tr);
		expect(text).toContain('/dns4/peer.example/tcp/443/wss/p2p/12D3KooW');
		expect(text).toContain('one-time-token-42');
		expect(tr.root.findAllByProps({testID: 'add-device-unavailable'})).toHaveLength(0);
	});

	it('any other engine failure renders the failed state, not the unavailable one and not details', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		mockConnectDevice.mockRejectedValue(new Error('EngineFactory: "network" must be built before "user"'));
		const tr = await renderScreen();
		expect(tr.root.findAllByProps({testID: 'add-device-failed'}).length).toBeGreaterThan(0);
		expect(tr.root.findAllByProps({testID: 'add-device-unavailable'})).toHaveLength(0);
		expect(textOf(tr)).not.toContain('qrInformation');
		warn.mockRestore();
	});

	it('an undefined user engine (no user bound on this network) renders the no-user state, not the generic failure', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		mockGetEngine.mockImplementationOnce(async () => undefined as never);
		const tr = await renderScreen();
		expect(tr.root.findAllByProps({testID: 'add-device-no-user'}).length).toBeGreaterThan(0);
		expect(textOf(tr)).toContain('connectDeviceNoUser');
		expect(tr.root.findAllByProps({testID: 'add-device-failed'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'add-device-unavailable'})).toHaveLength(0);
		expect(textOf(tr)).not.toContain('qrInformation');
		expect(mockConnectDevice).not.toHaveBeenCalled();
		// Not a failure: nothing is logged as a connectDevice error.
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('the screen source carries no hardcoded connection values', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		const source: string = fs.readFileSync(path.resolve(__dirname, '../AddDeviceScreen.tsx'), 'utf8');
		expect(source).not.toMatch(/MOCK_|relayrus|1234567890|AddedDevice"/);
	});
});
