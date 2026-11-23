/**
 * The Voter's scanner accepts exactly what the Authority's "Invite voters" QR encodes
 * (user ask, 2026-11-23: "build in both voter and the authority").
 *
 * The scanned value is not a hand-typed string. `readDisplayedQr` (an Authority test fixture,
 * imported by relative path) builds the PNG the Authority's Invite voters card shows for a join code
 * and reads it back with jsQR, so the text fed to the scanner here is what a camera reads off the
 * officer's screen. The codes are vote-engine's real-encoder fixtures (the same encoder the
 * Authority's `createVoterJoinCode` calls).
 *
 * The flow: Scan opens the camera, the read fills the field, the network name and fingerprint show
 * with Join ready, and ONE Join tap starts the join. Code text is compared with boolean assertions
 * only, so a failing matcher never prints a credential.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AccessibilityInfo, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from 'i18next';
import '../../../i18n';
import {decodeNetworkJoinCode, looksLikeJoinCode} from '@votetorrent/vote-engine/rn';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {JoinCodeFixtureName} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {DISPLAYED_QR_TARGETS_PX, readDisplayedQr} from '../../../../../VoteTorrentAuthority/src/screens/__fixtures__/displayed-qr';
import {lightTheme} from '../../../theme/themes';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
	...jest.requireActual('@react-navigation/native'),
	useNavigation: () => ({goBack: jest.fn(), navigate: mockNavigate, setParams: jest.fn(), setOptions: jest.fn()}),
}));

import JoinNetworkScreen from '../JoinNetworkScreen';
import JoinCodeScanner from '../JoinCodeScanner';

interface VcMock {
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;

const t = i18n.getFixedT('en', 'join');
const OK_NAMES: JoinCodeFixtureName[] = ['v2-1-member', 'v2-2-members', 'v2-6-members', 'v2-non-ascii-name', 'v1-legacy-1-member'];

let tr: renderer.ReactTestRenderer | undefined;
const byId = (id: string) => (tr as renderer.ReactTestRenderer).root.find(node => node.props.testID === id);
const textIn = (id: string) =>
	byId(id)
		.findAllByType(Text)
		.map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
		.join(' | ');
const cams = () => (tr as renderer.ReactTestRenderer).root.findAll(n => (n.type as unknown) === 'VisionCameraMock');

beforeEach(() => {
	mockJoinNetwork.mockReset();
	mockNavigate.mockReset();
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});

afterEach(() => {
	expect(mockNavigate).not.toHaveBeenCalled();
	renderer.act(() => {
		tr?.unmount();
	});
	tr = undefined;
	jest.restoreAllMocks();
});

describe.each(OK_NAMES)("the Authority's invite QR for %s", name => {
	const fx = JOIN_CODE_FIXTURES[name];

	it('reads back, at both display sizes, as the exact join code, which passes the scanner gate', () => {
		for (const target of DISPLAYED_QR_TARGETS_PX) {
			const read = readDisplayedQr(fx.text, target);
			expect(read !== null && read === fx.text).toBe(true);
			expect(looksLikeJoinCode(read)).toBe(true);
		}
	});

	it("the scanner hands the read to onAccept unchanged, once", () => {
		const payload = readDisplayedQr(fx.text, 1080) as string;
		const onAccept = jest.fn();
		renderer.act(() => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<JoinCodeScanner visible onAccept={onAccept} onClose={jest.fn()} onPasteInstead={jest.fn()} onCameraState={jest.fn()} />
				</ThemeProvider>,
			);
		});
		renderer.act(() => {
			bs.__emitBarcodes([{rawValue: payload}]);
		});
		expect(onAccept).toHaveBeenCalledTimes(1);
		expect(onAccept.mock.calls[0][0] === fx.text).toBe(true);
	});

	it('Scan -> camera -> the read shows the network name and fingerprint with Join ready -> one Join tap joins', async () => {
		const payload = readDisplayedQr(fx.text, 160 * 3) as string;
		renderer.act(() => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<JoinNetworkScreen />
				</ThemeProvider>,
				{createNodeMock: () => ({})},
			);
		});
		await renderer.act(async () => {
			byId('join-network-scan').props.onPress();
		});
		expect(cams()).toHaveLength(1);
		renderer.act(() => {
			bs.__emitBarcodes([{rawValue: payload}]);
		});
		expect(cams()).toHaveLength(0);
		expect(byId('join-network-code-input').props.value === fx.text).toBe(true);
		expect(byId('join-network-preview-name').props.children === fx.name).toBe(true);
		expect(byId('join-network-preview-fingerprint').props.children === fx.fingerprint).toBe(true);
		expect(textIn('join-network-scan-status')).toContain(t('scannedNotice'));
		expect(byId('join-network-submit').props.disabled).toBe(false);
		expect(mockJoinNetwork).not.toHaveBeenCalled();

		mockJoinNetwork.mockResolvedValue({
			ok: true,
			outcome: 'joined',
			admittedVia: 'redeemed',
			networkRef: {hash: fx.networkHash, relays: [], name: fx.name, primaryAuthorityDomainName: 'example.org'},
			fingerprint: fx.fingerprint,
		});
		await renderer.act(async () => {
			await byId('join-network-submit').props.onPress();
		});
		expect(mockJoinNetwork).toHaveBeenCalledTimes(1);
		const decoded = decodeNetworkJoinCode(fx.text);
		expect(decoded.ok && JSON.stringify(mockJoinNetwork.mock.calls[0][0]) === JSON.stringify(decoded.code)).toBe(true);
		expect(byId('join-network-joined')).toBeDefined();
	});
});
