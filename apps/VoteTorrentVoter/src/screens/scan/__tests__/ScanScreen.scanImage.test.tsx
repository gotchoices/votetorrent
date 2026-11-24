/**
 * ScanScreen: Choose image inside the Scan tab's scanner.
 *
 * Same harness as ScanScreen.test.tsx: a real NavigationContainer with a Vote tab and a Scan tab
 * whose stack holds `ScanHome`. The scanner opens as the tab comes into view; its Choose image
 * button reads a picked image (engines/qr-image-decode, mocked) through the scanner's own check. A
 * picked join code fills the field and never enters navigation state; anything else gets the
 * camera's banner. With the camera blocked, the tab's notice offers Choose image instead.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AccessibilityInfo, Text, View} from 'react-native';
import {NavigationContainer, ThemeProvider, createNavigationContainerRef} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import i18n from 'i18next';
import '../../../i18n';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {lightTheme} from '../../../theme/themes';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockAvailable = jest.fn(() => true);
const mockPick = jest.fn();
jest.mock('../../../engines/qr-image-decode', () => ({
	isQrImageDecodeAvailable: () => mockAvailable(),
	pickImageAndReadQrCodes: (deps: unknown) => mockPick(deps),
}));

import ScanScreen from '../ScanScreen';

interface VcMock {
	__setCameraPermissionStatus(s: string): void;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;

const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const t = i18n.getFixedT('en', 'join');

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
			{createNodeMock: () => ({})},
		);
	});
	await renderer.act(async () => {
		navigationRef.navigate('Scan');
		await Promise.resolve();
	});
}

type Inst = renderer.ReactTestInstance;
const root = () => tr!.root;
const cams = () => root().findAll(n => (n.type as unknown) === 'VisionCameraMock');
const hostById = (id: string): Inst | undefined => root().findAll(n => typeof n.type === 'string' && n.props.testID === id)[0];
function elWith(id: string, prop: string): Inst {
	const found = root().findAll(n => n.props.testID === id && typeof n.props[prop] === 'function')[0];
	if (!found) throw new Error('no element ' + id + ' with ' + prop);
	return found;
}
/** The text a host node shows: its string children, depth first, with no separator. */
function textOf(n: Inst): string {
	return n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
}
/** Icon glyphs (FontAwesome6 renders a private-use character) are not copy. */
const textIn = (id: string) => {
	const h = hostById(id);
	return h ? textOf(h).replace(/[\uE000-\uF8FF]/g, '') : '';
};
const inputValue = () => (hostById('join-network-code-input')?.props.value ?? '') as string;
async function press(id: string) {
	await renderer.act(async () => {
		await elWith(id, 'onPress').props.onPress();
	});
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	mockJoinNetwork.mockReset();
	mockPick.mockReset();
	mockAvailable.mockReset();
	mockAvailable.mockReturnValue(true);
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});
afterEach(async () => {
	expect(mockJoinNetwork).not.toHaveBeenCalled();
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = null;
	}
	jest.restoreAllMocks();
});

describe('ScanScreen: Choose image inside the scanner', () => {
	it('the scanner that opens with the tab has Choose image inside it', async () => {
		await mountOnScan();
		expect(cams().length).toBe(1);
		const scanner = hostById('join-network-scanner') as Inst;
		expect(scanner.findAll(n => typeof n.type === 'string' && n.props.testID === 'join-network-scan-image').length).toBe(1);
		expect(elWith('join-network-scan-image', 'onPress').props.accessibilityLabel).toBe(t('scanImageLabel'));
	});

	it('a picked join code fills the field and shows the network; it never joins and never enters navigation state', async () => {
		mockPick.mockResolvedValue({kind: 'decoded', values: [sample.text]});
		await mountOnScan();
		await press('join-network-scan-image');
		expect(cams().length).toBe(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(textIn('join-network-preview-name') === sample.name).toBe(true);
		const state = JSON.stringify(navigationRef.getRootState());
		expect(state.includes(sample.text.slice(0, 40))).toBe(false);
	});

	it('a picked QR that is not a join code gets the scan banner and the tab keeps scanning', async () => {
		mockPick.mockResolvedValue({kind: 'decoded', values: ['https://example.org/not-a-join-code']});
		await mountOnScan();
		await press('join-network-scan-image');
		expect(textIn('join-network-scan-banner')).toBe(t('scanNotJoinCode'));
		expect(cams().length).toBe(1);
		expect(cams()[0].props.isActive).toBe(true);
		expect(inputValue()).toBe('');
	});

	it('with the camera blocked the scanner stays shut, and the notice offers Choose image', async () => {
		vc.__setCameraPermissionStatus('denied');
		mockPick.mockResolvedValue({kind: 'decoded', values: [sample.text]});
		await mountOnScan();
		expect(cams().length).toBe(0);
		expect(textIn('join-network-scan-status')).toContain(t('cameraBlocked'));
		await press('join-network-scan-status-image');
		expect(inputValue() === sample.text).toBe(true);
	});
});
