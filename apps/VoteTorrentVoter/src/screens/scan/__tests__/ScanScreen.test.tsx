/**
 * ScanScreen: the Scan tab hosts the Join a network screen with its scanner.
 *
 * Mounted inside a real NavigationContainer with a two-tab navigator shaped like the app's (a Vote
 * tab, and a Scan tab whose native stack holds `ScanHome`), so tab focus, blur and Done's hop to
 * the Vote tab run through React Navigation itself. The provider is mocked; its `joinNetwork` is
 * the seam. Codes are the real-encoder fixtures, compared with boolean assertions only (a failing
 * matcher would print a bearer credential). VisionCamera is the manual mock; its `__` controls are
 * reached by require() of the mock FILE and only seed a new mount, so each test sets them first.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AccessibilityInfo, Text, View} from 'react-native';
import {NavigationContainer, ThemeProvider, createNavigationContainerRef} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import i18n from 'i18next';
import {resources} from '../../../i18n';
import type {NetworkJoinResult} from '@votetorrent/vote-engine/rn';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {lightTheme} from '../../../theme/themes';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));

import ScanScreen from '../ScanScreen';

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__cameraPermissionRequestCount(): number;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;

const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const t = i18n.getFixedT('en', 'join');
const joined: NetworkJoinResult = {
	ok: true,
	outcome: 'joined',
	admittedVia: 'redeemed',
	networkRef: {hash: sample.networkHash, relays: [], name: sample.name, primaryAuthorityDomainName: 'example.org'},
	fingerprint: sample.fingerprint,
} as NetworkJoinResult;

const Tab = createBottomTabNavigator();
const ScanStack = createNativeStackNavigator();
function VoteHome() {
	return (
		<View testID="vote-home">
			<Text>Vote</Text>
		</View>
	);
}
function ScanStackNavigator() {
	return (
		<ScanStack.Navigator>
			<ScanStack.Screen name="ScanHome" component={ScanScreen} />
		</ScanStack.Navigator>
	);
}

const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();
let tr: renderer.ReactTestRenderer | null = null;

async function goTo(tab: 'Vote' | 'Scan') {
	await renderer.act(async () => {
		navigationRef.navigate(tab);
		await Promise.resolve();
	});
}

/** Mounts on the Vote tab, then goes to Scan (the tab mounts lazily, on its first focus). */
async function mountOnScan() {
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer ref={navigationRef}>
				<ThemeProvider value={lightTheme}>
					<Tab.Navigator>
						<Tab.Screen name="Vote" component={VoteHome} />
						<Tab.Screen name="Scan" component={ScanStackNavigator} options={{headerShown: false}} />
					</Tab.Navigator>
				</ThemeProvider>
			</NavigationContainer>,
			// A host instance for the Scan button's ref (its focus-return call).
			{createNodeMock: () => ({})},
		);
	});
	await goTo('Scan');
}

const root = () => tr!.root;
const hasId = (id: string) => root().findAll(node => node.props.testID === id).length > 0;
const byId = (id: string) => root().find(node => node.props.testID === id);
const cams = () => root().findAll(n => (n.type as unknown) === 'VisionCameraMock');
const joinText = (nodes: renderer.ReactTestInstance[]) =>
	nodes.map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? ''))).join(' | ');
const allText = () => joinText(root().findAllByType(Text));
const textIn = (id: string) => joinText(byId(id).findAllByType(Text));
const inputValue = () => byId('join-network-code-input').props.value as string;
const focusedTab = () => {
	const state = navigationRef.getRootState();
	return state.routes[state.index ?? 0].name;
};
function emitScan(rawValue: string) {
	renderer.act(() => {
		bs.__emitBarcodes([{rawValue}]);
	});
}
async function press(id: string) {
	await renderer.act(async () => {
		await byId(id).props.onPress();
	});
}

beforeEach(() => {
	mockJoinNetwork.mockReset();
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});

afterEach(async () => {
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
	}
	jest.restoreAllMocks();
});

describe('ScanScreen: no placeholder', () => {
	it('renders the join form, not the old "coming soon" placeholder', async () => {
		vc.__setCameraDevice(undefined); // scanner stays shut, so only the form renders
		await mountOnScan();
		const text = allText();
		expect(text).not.toContain('coming soon');
		expect(text).not.toContain("isn't available yet");
		expect(hasId('join-network-submit')).toBe(true);
		expect(hasId('join-network-code-input')).toBe(true);
		expect(hasId('join-network-scan')).toBe(true);
		expect(text).toContain(t('intro'));
	});

	it('the placeholder copy is gone from both catalogs', () => {
		for (const lng of ['en', 'es'] as const) {
			const scan = (resources[lng] as unknown as Record<string, Record<string, string>>).scan;
			expect(Object.keys(scan).sort()).toEqual(['headerTitle']);
		}
	});
});

describe('ScanScreen: scan, check, then one tap to join', () => {
	it('opens the scanner as the tab comes into view', async () => {
		await mountOnScan();
		expect(cams().length).toBe(1);
		expect(byId('join-network-scan-title').props.children === t('scanTitle')).toBe(true);
	});

	it('a scanned join code fills the field and shows the name and fingerprint; it never joins on its own', async () => {
		await mountOnScan();
		emitScan(sample.text);
		expect(cams().length).toBe(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(byId('join-network-preview-name').props.children === sample.name).toBe(true);
		expect(byId('join-network-preview-fingerprint').props.children === sample.fingerprint).toBe(true);
		expect(textIn('join-network-scan-status')).toContain(t('scannedNotice'));
		expect(mockJoinNetwork).not.toHaveBeenCalled();
		expect(byId('join-network-submit').props.disabled).toBe(false);

		mockJoinNetwork.mockResolvedValue(joined);
		await press('join-network-submit');
		expect(mockJoinNetwork).toHaveBeenCalledTimes(1);
		expect(byId('join-network-joined').props.children === t('joinedTitle', {name: sample.name})).toBe(true);
	});

	it('the scanned code never enters navigation params', async () => {
		await mountOnScan();
		emitScan(sample.text);
		const state = JSON.stringify(navigationRef.getRootState());
		expect(state.includes(sample.text.slice(0, 40))).toBe(false);
		expect(state.includes(sample.fingerprint)).toBe(false);
	});

	it('a QR that is not a join code shows the banner and keeps scanning', async () => {
		await mountOnScan();
		emitScan('https://example.org/not-a-join-code');
		expect(cams().length).toBe(1);
		expect(textIn('join-network-scan-banner')).toContain(t('scanNotJoinCode'));
		expect(inputValue()).toBe('');
		expect(mockJoinNetwork).not.toHaveBeenCalled();
	});

	it('Paste instead closes the scanner onto the form with Paste ready', async () => {
		await mountOnScan();
		await press('join-network-scan-paste');
		expect(cams().length).toBe(0);
		expect(byId('join-network-paste').props.disabled).toBe(false);
		expect(byId('join-network-code-input').props.editable).toBe(true);
	});

	it('Done after a join opens the Vote tab, and the next visit starts clean with the scanner open', async () => {
		mockJoinNetwork.mockResolvedValue(joined);
		await mountOnScan();
		emitScan(sample.text);
		await press('join-network-submit');
		await press('join-network-done');
		expect(focusedTab()).toBe('Vote');
		expect(cams().length).toBe(0);

		await goTo('Scan');
		expect(hasId('join-network-joined')).toBe(false);
		expect(inputValue()).toBe('');
		expect(cams().length).toBe(1);
	});

	it("a phone already in another network gets the Join screen's own refusal", async () => {
		mockJoinNetwork.mockResolvedValue({ok: false, reason: 'other-cadre', detail: 'raw engine text'});
		await mountOnScan();
		emitScan(sample.text);
		await press('join-network-submit');
		expect((byId('join-network-error').props.children as string) === t('error.otherCadre')).toBe(true);
		expect(allText()).not.toContain('raw engine text');
	});
});

describe('ScanScreen: revisiting the tab', () => {
	it('leaving the tab turns the camera off', async () => {
		await mountOnScan();
		expect(cams().length).toBe(1);
		await goTo('Vote');
		expect(cams().length).toBe(0);
	});

	it('a scanned code waiting in the field is kept, and the scanner stays closed', async () => {
		await mountOnScan();
		emitScan(sample.text);
		await goTo('Vote');
		await goTo('Scan');
		expect(inputValue() === sample.text).toBe(true);
		expect(byId('join-network-preview-name').props.children === sample.name).toBe(true);
		expect(cams().length).toBe(0);
		expect(mockJoinNetwork).not.toHaveBeenCalled();
	});

	it('with an empty field, the scanner opens again', async () => {
		await mountOnScan();
		await press('join-network-scan-close');
		expect(cams().length).toBe(0);
		await goTo('Vote');
		await goTo('Scan');
		expect(cams().length).toBe(1);
	});
});

describe('ScanScreen: camera permission', () => {
	it('not asked yet: the first visit asks; granted opens the camera', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('authorized');
		await mountOnScan();
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(cams().length).toBe(1);
	});

	it('refused: shows cameraDenied, does not ask again on the next visit, and Scan still asks on a press', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('not-determined');
		await mountOnScan();
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(cams().length).toBe(0);
		expect(textIn('join-network-scan-status')).toContain(t('cameraDenied'));

		await goTo('Vote');
		await goTo('Scan');
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(textIn('join-network-scan-status')).toContain(t('cameraDenied'));

		await press('join-network-scan');
		expect(vc.__cameraPermissionRequestCount()).toBe(2);
	});

	it.each(['denied', 'restricted'])('blocked (%s): no camera, cameraBlocked with Open Settings, paste usable', async status => {
		vc.__setCameraPermissionStatus(status);
		await mountOnScan();
		expect(cams().length).toBe(0);
		expect(textIn('join-network-scan-status')).toContain(t('cameraBlocked'));
		expect(hasId('join-network-scan-open-settings')).toBe(true);
		expect(byId('join-network-scan').props.disabled).toBe(true);
		expect(byId('join-network-paste').props.disabled).toBe(false);
		await goTo('Vote');
		await goTo('Scan');
		expect(cams().length).toBe(0);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
	});

	it('no camera: cameraNone and paste usable', async () => {
		vc.__setCameraDevice(undefined);
		await mountOnScan();
		expect(cams().length).toBe(0);
		expect(textIn('join-network-scan-status')).toContain(t('cameraNone'));
		expect(byId('join-network-scan').props.disabled).toBe(true);
		expect(byId('join-network-paste').props.disabled).toBe(false);
	});
});

/**
 * 57-17/57-18 scroll-container guard (mirrors
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx). Walks
 * the RENDERED tree for a host node whose `type` is `RCTScrollView`, not a source grep.
 */
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

describe('ScanScreen: scroll container regression guard (57-17/57-18)', () => {
	it('renders a real RCTScrollView host node', async () => {
		vc.__setCameraDevice(undefined); // keep the scanner shut so only the form renders
		await mountOnScan();
		expect(findHostNodeByType(tr!.toJSON(), 'RCTScrollView')).not.toBeNull();
	});

	it('anti-vacuity: the walker returns null against a View-only synthetic tree', () => {
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
});
